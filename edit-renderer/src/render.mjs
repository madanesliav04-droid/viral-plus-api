import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {bundle} from '@remotion/bundler';
import {renderMedia,selectComposition} from '@remotion/renderer';

const arg=(name)=>{
  const i=process.argv.indexOf(name);
  return i>=0?process.argv[i+1]:null;
};

const inputPath=arg('--input');
const outputPath=arg('--output');
if(!inputPath||!outputPath){
  console.error('Usage: node src/render.mjs --input props.json --output output.mp4');
  process.exit(2);
}

const inputProps=JSON.parse(await fs.readFile(path.resolve(inputPath),'utf8'));
const serveUrl=await bundle({
  entryPoint:path.resolve('src/index.jsx'),
  onProgress:progress=>{
    console.log(JSON.stringify({event:'bundle_progress',progress:Math.round(progress*100)}));
  }
});

const composition=await selectComposition({
  serveUrl,
  id:'EditPlusVertical',
  inputProps
});

await renderMedia({
  composition,
  serveUrl,
  codec:'h264',
  pixelFormat:'yuv420p',
  outputLocation:path.resolve(outputPath),
  inputProps,
  onProgress:({progress})=>{
    console.log(JSON.stringify({event:'render_progress',progress:Math.round(progress*100)}));
  }
});

console.log(JSON.stringify({event:'render_completed',output:path.resolve(outputPath)}));
