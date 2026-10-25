import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import {spawn,spawnSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'

export const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)))
export async function startFixture(){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'sintonema-http-'))
 for(const name of ['bootstrap.php','schema.sql'])fs.copyFileSync(path.join(root,name),path.join(directory,name))
 for(const name of ['src','resources','bin'])fs.cpSync(path.join(root,name),path.join(directory,name),{recursive:true})
 const port=await new Promise((resolve,reject)=>{const s=net.createServer();s.once('error',reject);s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p))})})
 const base='http://127.0.0.1:'+port
 const env={...process.env,SINTONEMA_ADMIN_BASE_URL:base,SINTONEMA_TEST_PRIVATE_DIR:directory,SINTONEMA_PRIVATE_DIR:directory}
 const php=process.env.SINTONEMA_PHP||'php'
 const setup=spawnSync(php,[path.join(root,'tests/fixture.php')],{env,encoding:'utf8'})
 if(setup.status!==0){fs.rmSync(directory,{recursive:true,force:true});throw Error('HTTP fixture failed: '+setup.stdout+setup.stderr)}
 const fixture=JSON.parse(fs.readFileSync(path.join(directory,'fixture.json'),'utf8'))
 const log=fs.openSync(path.join(directory,'server.log'),'w')
 const child=spawn(php,['-S','127.0.0.1:'+port,'-t',path.join(root,'public')],{env,stdio:['ignore',log,log]});fs.closeSync(log)
 async function stop(){
  if(child.exitCode===null&&!child.killed){child.kill('SIGTERM');await new Promise(resolve=>{const timer=setTimeout(()=>{if(child.exitCode===null)child.kill('SIGKILL');resolve()},4000);child.once('exit',()=>{clearTimeout(timer);resolve()})})}
  const logs=fs.existsSync(path.join(directory,'server.log'))?fs.readFileSync(path.join(directory,'server.log'),'utf8'):''
  fs.rmSync(directory,{recursive:true,force:true});return logs
 }
 const deadline=Date.now()+12000
 while(true){
  if(child.exitCode!==null){const logs=await stop();throw Error('HTTP fixture exited: '+logs)}
  try{const response=await fetch(base+'/api.php?r=session');if(response.ok)break}catch{}
  if(Date.now()>deadline){const logs=await stop();throw Error('HTTP fixture startup timed out: '+logs)}
  await new Promise(resolve=>setTimeout(resolve,100))
 }
 return {base,directory,fixture,stop}
}
export function catalogue(title='História sintética HTTP'){
 return {format:'sintonema.catalogue',version:1,mode:'supplement',items:[{key:'tmdb:movie:999999999',title,year:2026,kind:'movie',categories:['fiction'],posterUrl:null,sourceUrl:'https://www.themoviedb.org/movie/999999999',attribution:'Dados sintéticos exclusivos dos testes'}]}
}
export function jar(base){
 let cookie='',csrf=''
 return {get cookie(){return cookie},get csrf(){return csrf},
  async request(route,body,options={}){
   const headers={...(cookie?{Cookie:cookie}:{}),...(body===undefined?{}:{Origin:base,'Content-Type':'application/json','X-CSRF-Token':csrf}),...options.headers}
   const response=await fetch(base+'/api.php?r='+route,{method:options.method||(body===undefined?'GET':'POST'),headers,body:body===undefined?undefined:options.raw??JSON.stringify(body)})
   for(const header of response.headers.getSetCookie()){const match=/^(?:__Host-)?SINTONEMA_ADMIN=([^;]*)/.exec(header);if(match)cookie=header.split(';')[0]}
   const raw=await response.text();let result=null;try{result=JSON.parse(raw)}catch{}
   if(result?.data?.csrf)csrf=result.data.csrf
   return {response,result,raw}
  },
 }
}
