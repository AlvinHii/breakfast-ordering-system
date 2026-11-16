// 僅由測試程序載入，固定為台北早上八點，避免測試受營業時間影響。
const RealDate = Date;
global.Date = class extends RealDate {
  constructor(...args) { super(...(args.length ? args : ['2030-01-01T00:00:00.000Z'])); }
  static now() { return new RealDate('2030-01-01T00:00:00.000Z').getTime(); }
};
