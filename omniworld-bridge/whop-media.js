"use strict";
const fs=require('node:fs');
const fsp=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
function createMedia({request,client,fetcher=fetch}){
 async function send(filename,body,size,type){
  const f=await request('files','POST',{filename,visibility:'private'});
  if(!f.id||!f.upload_url)throw Error('Whop : URL de transfert absente.');
  const u=new URL(f.upload_url);
  if(u.protocol!=='https:')throw Error('URL de transfert non sécurisée.');
  let r;
  try{r=await fetcher(u,{method:'PUT',headers:{'Content-Type':type,'Content-Length':String(size),...f.upload_headers},body,duplex:'half',redirect:'error',signal:AbortSignal.timeout(600000)});}catch{throw Error('Transfert du média interrompu.');}
  if(!r.ok)throw Error('Transfert du média : HTTP '+r.status);
  for(let n=0;n<60;n++){
   const done=await request('files/'+encodeURIComponent(f.id),'GET');
   if(done.upload_status==='ready')return f.id;
   if(done.upload_status==='failed')throw Error('Whop a refusé le fichier.');
   await wait(2000);
  }
  throw Error('Traitement du fichier Whop trop long.');
 }
 async function upload(m){
  const doc=m.media?.document;
  const size=Number(doc?.size||0);
  // Bound ephemeral disk usage; unsupported sizes stop the import visibly.
  if(size>100*1024*1024)throw Error('Fichier supérieur à 100 Mo : message '+m.id+'. Import en pause.');
  const original=doc?.attributes?.find(a=>a.fileName)?.fileName;
  const type=doc?.mimeType||(m.media?.photo?'image/jpeg':'application/octet-stream');
  const extension={'video/mp4':'.mp4','audio/ogg':'.ogg','audio/mpeg':'.mp3','image/jpeg':'.jpg','image/png':'.png','application/pdf':'.pdf'}[type]||'.bin';
  const filename=path.basename(original||('telegram-'+m.id+extension));
  const dir=await fsp.mkdtemp(path.join(os.tmpdir(),'omni-media-'));
  const target=path.join(dir,'download');
  try{
   await client.downloadMedia(m,{outputFile:target});
   const stat=await fsp.stat(target);
   if(!stat.size)throw Error('Média Telegram vide.');
   if(stat.size>100*1024*1024)throw Error('Média supérieur à 100 Mo.');
   const stream=fs.createReadStream(target);
   try{return await send(filename,stream,stat.size,type);}finally{stream.destroy();}
  }finally{await fsp.rm(dir,{recursive:true,force:true});}
 }
 async function test(){
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aM1sAAAAASUVORK5CYII=','base64');
  return send('omniworld-test.png',png,png.length,'image/png');
 }
 return {upload,test};
}
module.exports={createMedia};
