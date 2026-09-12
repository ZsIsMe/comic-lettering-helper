import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'
const source = await readFile(new URL('../src/comparison-regions.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText
const { comparisonRegions, adoptComparisonRegion } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)
function rgba(w,h,points) {const m=new Uint8ClampedArray(w*h*4);for(const [x,y] of points)m[(y*w+x)*4]=255;return m}
test('grouping covers sparse masks and existing mixed decisions without changing assignments',()=>{
 const w=120,h=72,a=new Uint16Array(w*h);a[60*w+115]=3;const original=a.slice(),m=rgba(w,h,[[0,0],[30,0]])
 const regions=comparisonRegions(w,h,[m],a)
 assert.equal(regions.length,2)
 for(const [x,y] of [[0,0],[30,0],[115,60]])assert.equal(regions.filter(r=>x>=r.x&&x<r.x+r.width&&y>=r.y&&y<r.y+r.height).length,1)
 assert.deepEqual(a,original)
})
test('adoption touches only selected candidate allowed pixels inside region and preserves mixed choices elsewhere',()=>{
 const w=8,h=3,a=new Uint16Array(w*h);a.fill(3);const mask=rgba(w,h,[[1,1],[6,1]])
 const next=adoptComparisonRegion(a,w,h,{x:0,y:0,width:4,height:3},2,new Map([[2,mask]]))
 assert.equal(next[9],2);assert.equal(next[14],3);assert.equal(next[10],3);assert.equal(a[9],3)
})
test('base restoration preserves unrelated pixels and missing candidates cannot alter data',()=>{
 const a=new Uint16Array([0,2,3,0]),mask=rgba(4,1,[[0,0]])
 assert.deepEqual(adoptComparisonRegion(a,4,1,{x:0,y:0,width:2,height:1},1,new Map([[2,mask]])),new Uint16Array([1,1,3,0]))
 assert.deepEqual(adoptComparisonRegion(a,4,1,{x:0,y:0,width:4,height:1},4,new Map([[2,mask]])),a)
})
test('passthrough pages have no repair regions',()=>assert.deepEqual(comparisonRegions(6,4,[],new Uint16Array(24)),[]))
