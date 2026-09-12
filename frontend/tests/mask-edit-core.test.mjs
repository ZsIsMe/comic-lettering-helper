import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'
const source=await readFile(new URL('../src/mask-edit-core.ts',import.meta.url),'utf8')
const compiled=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText
const {textRepairMask,categoryMask,applyCategoryMask,applySpecialSelection,mergeLayerRegion}=await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)
function fixture() {
 const overlay=new Uint8ClampedArray([255,255,255,255,0,0,0,0,0,0,0,0,0,0,0,0])
 const other=new Uint8ClampedArray([0,0,0,255,255,255,255,255,0,0,0,255,0,0,0,255])
 return {overlay,other,edited:new Uint8ClampedArray(16)}
}
test('subtract only touches target, clear touches both and protects manual exclusion',()=>{
 const original=fixture(),mask=categoryMask(original,'solid')
 const sub=applyCategoryMask(original,mask,new Uint8Array(4),'solid',[255,255,255])
 assert.equal(sub.other[4],255);assert.equal(sub.overlay[3],0)
 const cleared=applySpecialSelection(original,new Uint8Array([1,1,1,0]),'clear',[255,255,255])
 assert.equal(cleared.other[4],0);assert.equal(cleared.overlay[3],0);assert.equal(cleared.edited[8],255)
 assert.equal(original.other[4],255);assert.equal(original.overlay[3],255)
})
test('swap exchanges both categories together and preserves empty pixels and input',()=>{
 const original=fixture(),before=structuredClone(original)
 const swapped=applySpecialSelection(original,new Uint8Array([1,1,1,0]),'swap',[10,20,30])
 assert.deepEqual([...categoryMask(swapped,'solid')],[0,1,0,0])
 assert.deepEqual([...categoryMask(swapped,'other')],[1,0,0,0])
 assert.deepEqual([...swapped.overlay.slice(4,8)],[10,20,30,255])
 assert.deepEqual([...swapped.edited.slice(0,8)],new Array(8).fill(255))
 for(const key of ['overlay','other','edited']) assert.deepEqual(swapped[key].slice(8),original[key].slice(8))
 assert.deepEqual(original,before)
})
test('swap leaves both kinds of mask outside the rectangle untouched',()=>{
 const original=fixture()
 for (const selection of [[1,0,0,0],[0,1,0,0],[0,0,1,0]]) {
  const swapped=applySpecialSelection(original,new Uint8Array(selection),'swap',[255,255,255])
  for(let n=0;n<4;n++) if(!selection[n]) {
   for(const key of ['overlay','other','edited']) assert.deepEqual(swapped[key].slice(n*4,n*4+4),original[key].slice(n*4,n*4+4))
  }
 }
})
test('swap twice restores both masks; drag recomputation always reads the initial snapshot',()=>{
 const original=fixture(),selection=new Uint8Array([1,1,1,0])
 const first=applySpecialSelection(original,selection,'swap',[255,255,255])
 const repeated=applySpecialSelection(original,selection,'swap',[255,255,255])
 assert.deepEqual(first,repeated)
 const twice=applySpecialSelection(first,selection,'swap',[255,255,255])
 assert.deepEqual(twice.overlay,original.overlay)
 assert.deepEqual(twice.other,original.other)
})
test('swap on an empty selection or empty pixels makes no edit',()=>{
 const original=fixture()
 for(const selection of [[0,0,0,0],[0,0,1,1]]) {
  assert.deepEqual(applySpecialSelection(original,new Uint8Array(selection),'swap',[10,20,30]),original)
 }
})
test('adding an opposite category clears original category; clip preserves outside',()=>{
 const original=fixture(),before=categoryMask(original,'other')
 const next=applyCategoryMask(original,before,new Uint8Array([1,1,1,1]),'other',[1,2,3],new Uint8Array([1,1,0,0]))
 assert.equal(next.overlay[3],0);assert.equal(next.other[0],255);assert.equal(next.edited[0],255)
 assert.equal(next.other[8],0);assert.equal(next.edited[8],0)
})
test('local apply merges final ROI only and retains original for cancel/undo',()=>{
 const original=fixture(),draft=applySpecialSelection(original,new Uint8Array([1,1,1,1]),'clear',[0,0,0])
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

function bubbleFixture() {
 const width=21,height=21,overlay=new Uint8ClampedArray(width*height*4),other=new Uint8ClampedArray(overlay.length),edited=new Uint8ClampedArray(overlay.length),text=new Uint8ClampedArray(overlay.length)
 for(let n=0;n<width*height;n++) other[n*4+3]=255
 for(let y=1;y<20;y++) for(let x=1;x<20;x++) overlay.set([240,240,240,255],(y*width+x)*4)
 text[(10*width+10)*4]=255
 edited.set([255,255,255,255],(2*width+2)*4)
 // An existing repair pixel must move to solid in the same swap.
 overlay.set([0,0,0,0],(18*width+18)*4);other.set([255,255,255,255],(18*width+18)*4)
 return {width,height,text,layers:{overlay,other,edited}}
}
test('bubble swap drops expanded background but transfers text margin, manual paint and opposite mask',()=>{
 const {width,height,text,layers}=bubbleFixture(),before=structuredClone(layers)
 const repair=textRepairMask(text,width,height),selection=new Uint8Array(width*height).fill(1)
 const swapped=applySpecialSelection(layers,selection,'swap',[30,40,50],repair)
 assert.equal(categoryMask(swapped,'other').reduce((a,b)=>a+b),34) // 33px ellipse + manual pixel
 assert.equal(swapped.other[(2*width+2)*4],255)
 assert.equal(swapped.other[(3*width+3)*4],0)
 assert.equal(swapped.overlay[(3*width+3)*4+3],0)
 assert.equal(swapped.edited[(3*width+3)*4],255) // Keep discarded background excluded on reclassification.
 assert.deepEqual([...swapped.overlay.slice((18*width+18)*4,(18*width+18)*4+4)],[30,40,50,255])
 assert.equal(swapped.other[(18*width+18)*4],0)
 assert.deepEqual(layers,before) // Undo's snapshot retains the original bubble fill and colors.
 assert.deepEqual(applySpecialSelection(layers,selection,'swap',[30,40,50],repair),swapped)
})
test('bubble swap clips transfer and fill removal to selection, including local ROI',()=>{
 const {width,height,text,layers}=bubbleFixture(),selection=new Uint8Array(width*height)
 for(let y=0;y<height;y++) selection.fill(1,y*width,y*width+10)
 const swapped=applySpecialSelection(layers,selection,'swap',[255,255,255],textRepairMask(text,width,height))
 for(let n=0;n<selection.length;n++) if(!selection[n]) {
  for(const key of ['overlay','other','edited']) assert.deepEqual(swapped[key].slice(n*4,n*4+4),layers[key].slice(n*4,n*4+4))
 }
 assert.equal(swapped.other[(10*width+9)*4],255)
 assert.equal(swapped.other[(3*width+3)*4],0)
})
test('repair text uses 3px ellipse and safely falls back without valid detection data',()=>{
 const text=new Uint8ClampedArray(9*9*4);text[(4*9+4)*4]=255
 const expanded=textRepairMask(text,9,9)
 assert.deepEqual(Array.from({length:9},(_,y)=>expanded.slice(y*9,y*9+9).reduce((a,b)=>a+b)),[0,1,5,7,7,7,5,1,0])
 assert.equal(textRepairMask(null,9,9),null)
 assert.equal(textRepairMask(new Uint8ClampedArray(9*9*4),9,9),null)
 assert.equal(textRepairMask(text,8,9),null)
 const original=fixture()
 for(const invalid of [null,new Uint8ClampedArray(16),new Uint8ClampedArray(4)]) {
  const swapped=applySpecialSelection(original,new Uint8Array([1,1,1,0]),'swap',[255,255,255],textRepairMask(invalid,2,2))
  assert.deepEqual([...categoryMask(swapped,'solid')],[0,1,0,0])
  assert.deepEqual([...categoryMask(swapped,'other')],[1,0,0,0])
 }
})
