'use strict';
const { databaseConfig, databaseError } = require('../config');
const { Storage } = require('../storage');
const additions = [
  ['起司蛋餅',45,'蛋餅'],['玉米蛋餅',45,'蛋餅'],['鮪魚蛋餅',50,'蛋餅'],['培根蛋餅',50,'蛋餅'],
  ['培根蛋堡',55,'漢堡吐司'],['鮪魚蛋吐司',50,'漢堡吐司'],['花生厚片',35,'厚片吐司'],['巧克力厚片',35,'厚片吐司'],
  ['卡啦雞腿堡',75,'漢堡吐司'],['蘿蔔糕',40,'主食點心'],['蘑菇鐵板麵',65,'主食點心'],['黑胡椒鐵板麵',65,'主食點心'],
  ['美式咖啡',40,'飲料'],['鮮奶茶',45,'飲料'],
];
async function main() {
  const storage = new Storage(databaseConfig());
  try {
    await storage.transaction(async client => {
      const previous = await storage.load(client);
      const state = structuredClone(previous);
      state.seq.menu = Math.max(state.seq.menu, ...state.menu.map(x=>x.id));
      state.seq.combo = Math.max(state.seq.combo, ...state.combos.map(x=>x.id));
      const added = [];
      for (const [name,price,category] of additions) {
        if (state.menu.some(x=>x.name===name)) continue;
        const groups = category === '飲料'
          ? [{name:'溫度',type:'one',choices:[{label:'冰',price:0},{label:'熱',price:0}]}]
          : [{name:'加料',type:'many',choices:[{label:'加蛋',price:10},{label:'加起司',price:10}]}];
        state.menu.push({id:++state.seq.menu,name,price,category,desc:name,groups,photo:'',available:true});
        added.push(name);
      }
      for (const [name,price,names] of [
        ['元氣蛋餅套餐',50,['蛋餅','紅茶']],
        ['吐司奶茶套餐',60,['火腿蛋吐司','奶茶']],
        ['飽足雞腿套餐',90,['卡啦雞腿堡','紅茶']],
      ]) {
        if (state.combos.some(x=>x.name===name)) continue;
        const items = names.map(n=>{
          const item = state.menu.find(x=>x.name===n);
          if (!item) throw new Error('套餐缺少單品');
          return {ref:item.id,qty:1};
        });
        state.combos.push({id:++state.seq.combo,name,price,desc:names.join('＋'),items,photo:'',available:true});
        added.push(name);
      }
      if (process.argv.includes('--apply')) await storage.save(client,state,previous);
      console.log(JSON.stringify({applied:process.argv.includes('--apply'),added,menuCount:state.menu.length,comboCount:state.combos.length},null,2));
    });
  } finally { await storage.close(); }
}
main().catch(error=>{console.error(databaseError(error));process.exitCode=1;});
