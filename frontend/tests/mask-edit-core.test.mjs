import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'
const source=await readFile(new URL('../src/mask-edit-core.ts',import.meta.url),'utf8')
const compiled=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText
const {categoryMask,applyCategoryMask,applySpecialSelection,mergeLayerRegion}=await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)
function fixture() {
 const overlay=new Uint8ClampedArray([255,255,255,255,0,0,0,0,0,0,0,0,0,0,0,0])
 const other=new Uint8ClampedArray([0,0,0,255,255,255,255,255,0,0,0,255,0,0,0,255])
 return {overlay,other,edited:new Uint8ClampedArray(16)}
}
test('subtract only touches target, clear touches both and protects manual exclusion',()=>{
 const original=fixture(),mask=categoryMask(original,'solid')
 const sub=applyCategoryMask(original,mask,new Uint8Array(4),'solid',[255,255,255])
 assert.equal(sub.other[4],255);assert.equal(sub.overlay[3],0)
 const cleared=applySpecialSelection(original,new Uint8Array([1,1,1,0]),'clear','solid',[255,255,255])
 assert.equal(cleared.other[4],0);assert.equal(cleared.overlay[3],0);assert.equal(cleared.edited[8],255)
 assert.equal(original.other[4],255);assert.equal(original.overlay[3],255)
})
test('transfer moves only intersecting opposite category and keeps layers exclusive',()=>{
 const original=fixture()
 const moved=applySpecialSelection(original,new Uint8Array([0,1,1,0]),'transfer','solid',[10,20,30])
 assert.deepEqual([...moved.overlay.slice(4,8)],[10,20,30,255]);assert.equal(moved.other[4],0);assert.equal(moved.edited[4],255)
 assert.equal(moved.overlay[11],0);assert.equal(moved.edited[8],0)
 const back=applySpecialSelection(moved,new Uint8Array([0,1,0,0]),'transfer','other',[0,0,0])
 assert.equal(back.overlay[7],0);assert.equal(back.other[4],255)
})
test('adding an opposite category clears original category; clip preserves outside',()=>{
 const original=fixture(),before=categoryMask(original,'other')
 const next=applyCategoryMask(original,before,new Uint8Array([1,1,1,1]),'other',[1,2,3],new Uint8Array([1,1,0,0]))
 assert.equal(next.overlay[3],0);assert.equal(next.other[0],255);assert.equal(next.edited[0],255)
 assert.equal(next.other[8],0);assert.equal(next.edited[8],0)
})
test('local apply merges final ROI only and retains original for cancel/undo',()=>{
 const original=fixture(),draft=applySpecialSelection(original,new Uint8Array([1,1,1,1]),'clear','solid',[0,0,0])
 const merged=mergeLayerRegion(original,draft,2,2,{x:1,y:0,width:1,height:1})
 assert.equal(merged.overlay[3],255);assert.equal(merged.other[4],0);assert.equal(merged.edited[8],0)
 assert.equal(original.other[4],255)
})

test('repainting existing selected fill changes only painted colour and records manual edit',()=>{
 const original=fixture(),before=categoryMask(original,'solid')
 const painted=applyCategoryMask(original,before,before,'solid',[10,20,30],undefined,new Uint8Array([1,0,0,0]))
 assert.deepEqual([...painted.overlay.slice(0,4)],[10,20,30,255]);assert.equal(painted.edited[0],255)
 assert.equal(painted.other[4],255);assert.equal(original.overlay[0],255)
})
