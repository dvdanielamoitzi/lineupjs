import {IWorkerMessage, INumberStatsMessageRequest, IAdvancedBoxPlotData, ICategoricalStatistics, IDateStatistics, IStatistics, ICategoricalStatsMessageRequest, IDateStatsMessageRequest, IBoxPlotStatsMessageRequest} from './math';
import {UIntTypedArray, IndicesArray} from '../model';

/**
 * @internal
 */
export interface IPoorManWorkerScopeEventMap {
  message: MessageEvent;
  error: ErrorEvent;
}

/**
 * @internal
 */
export interface IPoorManWorkerScope {
  onmessage: ((this: IPoorManWorkerScope, ev: MessageEvent) => any) | null;
  onerror: ((this: IPoorManWorkerScope, ev: ErrorEvent) => any) | null;
  close(): void;
  postMessage(message: any, transfer?: Transferable[]): void;
  addEventListener<K extends keyof IPoorManWorkerScopeEventMap>(type: K, listener: (this: IPoorManWorkerScope, ev: IPoorManWorkerScopeEventMap[K]) => any, options?: boolean | AddEventListenerOptions): void;
  removeEventListener<K extends keyof IPoorManWorkerScopeEventMap>(type: K, listener: (this: IPoorManWorkerScope, ev: IPoorManWorkerScopeEventMap[K]) => any, options?: boolean | AddEventListenerOptions): void;
}

// function workerMain(self: IPoorManWorkerScope) {
//   self.addEventListener('message', (evt) => {
//     self.postMessage(`Worker: ${evt.data} - Polo`);
//   });
// }

/**
 * @internal
 */
export function toFunctionBody(f: Function) {
  const source = f.toString();
  return source.slice(source.indexOf('{') + 1, source.lastIndexOf('}'));
}

/**
 * create a blob out of the given function or string
 * @internal
 */
export function createWorkerCodeBlob(fs: (string | Function)[]) {
  const sources = fs.map((d) => d.toString()).join('\n\n');

  const blob = new Blob([sources], {type: 'application/javascript'});
  return URL.createObjectURL(blob);
}

const MIN_WORKER_THREADS = 1;
const MAX_WORKER_THREADS = Math.max(navigator.hardwareConcurrency - 1, 1); // keep one for the ui

const THREAD_CLEANUP_TIME = 10000; // 10s

interface ITaskWorker {
  /**
   * worker index
   */
  index: number;
  /**
   * worker itself
   */
  worker: Worker;
  /**
   * set of active task numbers
   */
  tasks: Set<number>;
  /**
   * list of references that are stored on this worker
   */
  refs: Set<string>;
}

/**
 * task scheduler based on web worker
 * @internal
 */
export class WorkerTaskScheduler {
  private readonly workers: ITaskWorker[] = [];
  private cleanUpWorkerTimer: number = -1;
  /**
   * worker task id
   */
  private workerTaskCounter = 0;

  constructor(private readonly blob: string) {
    for (let i = 0; i < MIN_WORKER_THREADS; ++i) {
      const w = new Worker(blob);
      this.workers.push({worker: w, tasks: new Set(), refs: new Set(), index: i});
    }
  }

  terminate() {
    this.workers.splice(0, this.workers.length).forEach((w) => w.worker.terminate());
  }

  private readonly cleanUpWorker = () => {
    // delete workers when they are not needed anymore
    this.workers.splice(0, this.workers.length - MIN_WORKER_THREADS).forEach((w) => w.worker.terminate());
  }

  private checkOutWorker() {
    if (this.cleanUpWorkerTimer >= 0) {
      clearTimeout(this.cleanUpWorkerTimer);
      this.cleanUpWorkerTimer = -1;
    }

    const emptyWorker = this.workers.find((d) => d.tasks.size === 0);

    if (emptyWorker) {
      return emptyWorker;
    }

    if (this.workers.length >= MAX_WORKER_THREADS) {
      // find the one with the fewest tasks
      return this.workers.reduce((a, b) => a == null || a.tasks.size > b.tasks.size ? b : a, <ITaskWorker | null>null)!;
    }

    // create new one
    const r: ITaskWorker = {
      worker: new Worker(this.blob),
      tasks: new Set<number>(),
      refs: new Set(),
      index: this.workers.length,
    };
    this.workers.push(r);
    return r;
  }

  private finshedTask() {
    if (this.cleanUpWorkerTimer === -1 && this.workers.length > MIN_WORKER_THREADS) {
      this.cleanUpWorkerTimer = self.setTimeout(this.cleanUpWorker, THREAD_CLEANUP_TIME);
    }
  }

  pushStats(type: 'numberStats', args: Partial<INumberStatsMessageRequest>, refData: string, data: Float32Array, refIndices?: string, indices?: IndicesArray): Promise<IStatistics>;
  pushStats(type: 'boxplotStats', args: Partial<IBoxPlotStatsMessageRequest>, refData: string, data: Float32Array, refIndices?: string, indices?: IndicesArray): Promise<IAdvancedBoxPlotData>;
  pushStats(type: 'categoricalStats', args: Partial<ICategoricalStatsMessageRequest>, refData: string, data: UIntTypedArray, refIndices?: string, indices?: IndicesArray): Promise<ICategoricalStatistics>;
  pushStats(type: 'dateStats', args: Partial<IDateStatsMessageRequest>, refData: string, data: Int32Array, refIndices?: string, indices?: IndicesArray): Promise<IDateStatistics>;
  pushStats(type: 'numberStats' | 'boxplotStats' | 'categoricalStats' | 'dateStats', args: any, refData: string, data: Float32Array | UIntTypedArray | Int32Array, refIndices?: string, indices?: IndicesArray) {
    return new Promise((resolve) => {
      const uid = this.workerTaskCounter++;
      const {worker, tasks, refs} = this.checkOutWorker();

      const receiver = (msg: MessageEvent) => {
        const r = <IWorkerMessage>msg.data;
        if (r.uid !== uid || r.type !== type) {
          return;
        }
        worker.removeEventListener('message', receiver);
        tasks.delete(uid);
        this.finshedTask();
        resolve((<any>r).stats);
      };

      worker.addEventListener('message', receiver);

      tasks.add(uid);

      const msg: any = Object.assign({
        type,
        uid,
        refData,
        refIndices: refIndices || null
      }, args);

      if (!refData || !refs.has(refData)) {
        // need to transfer to worker
        msg.data = data;
        if (refData) { // save that this worker has this ref
          refs.add(refData);
        }
        // console.log(index, 'set ref (i)', refData);
      }
      if (indices && (!refIndices || !refs.has(refIndices))) {
        // need to transfer
        msg.indices = indices!;
        if (refIndices) {
          refs.add(refIndices);
        }
        // console.log(index, 'set ref (i)', refIndices);
      }
      // console.log(index, msg);

      worker.postMessage(msg);
    });
  }

  push<M, R>(type: string, args: Exclude<M, IWorkerMessage>, transferAbles: ArrayBuffer[]): Promise<R>;
  push<M, R, T>(type: string, args: Exclude<M, IWorkerMessage>, transferAbles: ArrayBuffer[], toResult: (r: R) => T): Promise<T>;
  push<M, R, T>(type: string, args: Exclude<M, IWorkerMessage>, transferAbles: ArrayBuffer[], toResult?: (r: R) => T): Promise<T> {
    return new Promise<T>((resolve) => {
      const uid = this.workerTaskCounter++;
      const {worker, tasks} = this.checkOutWorker();

      const receiver = (msg: MessageEvent) => {
        const r = <IWorkerMessage>msg.data;
        if (r.uid !== uid || r.type !== type) {
          return;
        }
        worker.removeEventListener('message', receiver);
        tasks.delete(uid);
        this.finshedTask();
        resolve(toResult ? toResult(<any>r) : <any>r);
      };

      worker.addEventListener('message', receiver);
      tasks.add(uid);
      const msg = Object.assign({
        type,
        uid
      }, args);
      // console.log(index, msg);
      worker.postMessage(msg, transferAbles);
    });
  }

  setRef(ref: string, data: Float32Array | UIntTypedArray | Int32Array | IndicesArray) {
    for (const w of this.workers) {
      w.refs.add(ref);
    }
    this.broadCast('setRef', {
      ref,
      data
    });
  }

  deleteRef(ref: string, startsWith = false) {
    const uid = this.workerTaskCounter++;
    const msg = {
      type: 'deleteRef',
      uid,
      ref,
      startsWith
    };
    for (const w of this.workers) {
      // console.log(w.index, 'delete ref', ref, startsWith);
      w.worker.postMessage(msg);
      if (startsWith) {
        w.refs.delete(ref);
        continue;
      }
      for (const r of Array.from(w.refs)) {
        if (r.startsWith(ref)) {
          w.refs.delete(r);
        }
      }
    }
  }

  deleteRefs() {
    const uid = this.workerTaskCounter++;
    const msg = {
      type: 'deleteRef',
      uid,
      ref: '',
      startsWith: true
    };
    for (const w of this.workers) {
      // console.log(w.index, 'delete refs');
      w.worker.postMessage(msg);
      w.refs.clear();
    }
  }

  broadCast<T>(type: string, args: T) {
    const uid = this.workerTaskCounter++;
    // don't store in tasks queue since there is no response
    const msg = Object.assign({
      type,
      uid
    }, args);
    // console.log('broadcast', msg);
    for (const w of this.workers) {
      w.worker.postMessage(msg);
    }
  }

}