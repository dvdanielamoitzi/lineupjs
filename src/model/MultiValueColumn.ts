/**
 * Created by bikramkawan on 24/11/2016.
 */
import {median, quantile, mean, scale as d3scale} from 'd3';
import ValueColumn, {IValueColumnDesc} from './ValueColumn';
import Column from './Column';
import {IBoxPlotColumn, IBoxPlotData, SORT_METHOD, SortMethod} from './BoxPlotColumn';

/**
 * helper class to lazily compute box plotdata out of a given number array
 */
class LazyBoxPlotData implements IBoxPlotData {
  private _sorted: number[] = null;

  constructor(private readonly values: number[]) {

  }

  /**
   * lazy compute sorted array
   * @returns {number[]}
   */
  private get sorted() {
    if (this._sorted === null) {
      this._sorted = this.values.slice().sort();
    }
    return this._sorted;
  }

  get min() {
    return Math.min(...this.values);
  }

  get max() {
    return Math.max(...this.values);
  }

  get median() {
    return median(this.sorted);
  }

  get q1() {
    return quantile(this.sorted, 0.25);
  }

  get q3() {
    return quantile(this.sorted, 0.75);
  }

  get mean() {
    return mean(this.values);
  }
}

export interface IMultiValueColumn {
  getNumber(row: any, index: number): number[];
}

export interface IMultiValueColumnDesc extends IValueColumnDesc<number[]> {
  readonly domain?: number[];
  readonly sort?: string;
  readonly threshold?: number;
  readonly dataLength?: number;
  readonly colorRange?: string[];

}


export default class MultiValueColumn extends ValueColumn<number[]> implements IBoxPlotColumn,IMultiValueColumn {
  private readonly domain;
  private sort;
  private readonly threshold;
  private readonly dataLength;
  private readonly colorRange;

  constructor(id: string, desc: IMultiValueColumnDesc) {
    super(id, desc);
    this.domain = desc.domain || [0, 100];
    this.dataLength = desc.dataLength;
    this.threshold = desc.threshold || 0;
    this.colorRange = desc.colorRange || ['blue', 'red'];
    this.sort = desc.sort || SORT_METHOD.min;

    const rendererList = [{type: 'multiValue', label: 'Heatmap'},
      {type: 'boxplot', label: 'Boxplot'},
      {type: 'sparkline', label: 'Sparkline'},
      {type: 'threshold', label: 'Threshold'},
      {type: 'verticalbar', label: 'VerticalBar'}];

    this.setRendererList(rendererList);

  }


  private getColorValues(): string[] {
    if (this.colorRange.length > 2) {
      return this.colorRange.slice();
    } else {
      const minColor = this.colorRange[0];
      const zeroColor = 'white';
      const maxColor = this.colorRange[1];
      return [minColor, zeroColor, maxColor];
    }
  }

  compare(a: any, b: any, aIndex: number, bIndex: number) {
    const aVal = this.getBoxPlotData(a, aIndex);
    const bVal = this.getBoxPlotData(b, bIndex);

    if (aVal === null) {
      return bVal === null ? 0 : +1;
    }
    if (bVal === null) {
      return -1;
    }

    return aVal[this.sort] - bVal[this.sort];
  }

  getColorScale() {
    const colorScale = d3scale.linear<string, number>();
    const colorValues = this.getColorValues();
    if (this.domain[0] < 0) {
      colorScale
        .domain([this.domain[0], 0, this.domain[1]])
        .range(colorValues);

    } else {
      colorScale
        .domain([this.domain[0], this.domain[1]])
        .range(colorValues);
    }
    return colorScale;
  }

  getNumber(row: any, index: number) {
    return this.getValue(row, index);
  }

  calculateCellDimension(width: number) {
    return (width / this.dataLength);
  }

  getSparklineScale() {
    const xposScale = d3scale.linear();
    const yposScale = d3scale.linear();
    const sparklineScale = {
      xScale: xposScale.domain([0, this.dataLength - 1]),
      yScale: yposScale.domain(this.domain)
    };

    return sparklineScale;
  }


  getDomain() {
    return this.domain;
  }

  getThreshold() {
    return this.threshold;
  }

  getVerticalBarScale() {
    return d3scale.linear().domain(this.domain);
  }


  getBoxPlotData(row: any, index: number): IBoxPlotData {
    const data = this.getValue(row, index);
    if (data === null) {
      return null;
    }
    return new LazyBoxPlotData(data);
  }

  getSortMethod() {
    return this.sort;
  }

  setSortMethod(sort: string) {
    if (this.sort === sort) {
      return;
    }
    this.fire([Column.EVENT_SORTMETHOD_CHANGED, Column.EVENT_DIRTY_VALUES, Column.EVENT_DIRTY], this.sort, this.sort = sort);
    // sort by me if not already sorted by me
    if (this.findMyRanker().getSortCriteria().col !== this) {
      this.sortByMe();
    }
  }
}

