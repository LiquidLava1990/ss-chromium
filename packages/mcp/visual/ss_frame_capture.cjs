// Crop an observed, fully visible frame from a viewport capture. This avoids
// Chromium's beyond-viewport element capture, which can resize/reset canvases.
const fs=require('node:fs');
const {promisify}=require('node:util');
const run=promisify(require('node:child_process').execFile);
const geometryScript='(el) => {const r=el.getBoundingClientRect();return {host:new URL(el.src).hostname,x:r.x-(visualViewport?.offsetLeft||0),y:r.y-(visualViewport?.offsetTop||0),w:r.width,h:r.height,vw:visualViewport?.width??innerWidth,vh:visualViewport?.height??innerHeight}}';
const crop=String.raw`
import cv2,json,math,sys
image=cv2.imread(sys.argv[1]);g=json.loads(sys.argv[3])
if image is None:raise ValueError('Invalid viewport capture')
h,w=image.shape[:2]
if not all(math.isfinite(g[k]) for k in ('x','y','w','h','vw','vh')):raise ValueError('Invalid frame geometry')
if min(g['w'],g['h'],g['vw'],g['vh'])<=0:raise ValueError('Invalid frame dimensions')
sx,sy=w/g['vw'],h/g['vh']
if abs(sx/sy-1)>.005:raise ValueError('Viewport capture scale is inconsistent')
left,top,right,bottom=[round(v) for v in (g['x']*sx,g['y']*sy,(g['x']+g['w'])*sx,(g['y']+g['h'])*sy)]
if not(0<=left<right<=w and 0<=top<bottom<=h):raise ValueError('Frame is outside viewport capture')
if not cv2.imwrite(sys.argv[2],image[top:bottom,left:right],[cv2.IMWRITE_JPEG_QUALITY,95]):raise ValueError('Could not save frame crop')
`;
async function captureFrame(call,frame,geometry,destination){
 const viewport=destination+'.viewport.jpg';
 try{
  const text=await call(`screenshot --path "${viewport}"\neval "${geometryScript}" ${frame}`);
  const current=JSON.parse(text.split('\n').find(line=>line.startsWith('{'))||'null');
  if(JSON.stringify(current)!==JSON.stringify(geometry))throw Error('Challenge geometry changed during viewport capture: '+JSON.stringify({expected:geometry,current}));
  await run('python',['-c',crop,viewport,destination,JSON.stringify(geometry)],{timeout:15000,maxBuffer:2000});
 }finally{try{fs.unlinkSync(viewport)}catch(e){if(e.code!=='ENOENT')throw e}}
}
module.exports={captureFrame,geometryScript};
