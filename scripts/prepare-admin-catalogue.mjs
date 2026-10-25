import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const read=name=>JSON.parse(fs.readFileSync(path.join(root,'src',name),'utf8'))
const output=process.argv[2]
if(!output||!path.isAbsolute(output))throw Error('Informe um arquivo de saída absoluto que ainda não exista.')
const films=read('films.json'),posters=read('catalogPosters.json'),pilot=read('mediaPilotData.json')
if(films.length!==1000||new Set(films.map(f=>f.id)).size!==1000)throw Error('Catálogo de origem inesperado.')
const items=films.map(f=>({key:'local:movie:'+f.id,title:f.title,year:f.year,kind:'movie',categories:[],
 posterUrl:posters[f.id]??null,sourceUrl:null,attribution:'Curadoria inicial Sintonema; imagens TMDb sujeitas a revisão de direitos.'}))
for(const entry of pilot.entries){
 if(!/^tvmaze:tv:[1-9][0-9]*$/.test(entry.media.key))throw Error('Identidade do piloto inesperada.')
 items.push({key:entry.media.key,title:entry.media.title,year:entry.media.year,kind:'series',
  categories:entry.media.classifications.filter(c=>['anime','animation','reality','documentary'].includes(c)),
  posterUrl:entry.posterUrl,sourceUrl:entry.sourceUrl,
  attribution:'Dados: TVmaze · CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0/). Imagens exigem revisão própria.'})
}
const payload={format:'sintonema.catalogue',version:1,mode:'supplement',items}
fs.writeFileSync(output,JSON.stringify(payload,null,2)+'\n',{flag:'wx',mode:0o600})
console.log('Preparados '+items.length+' candidatos para importar como rascunho. Nenhum título foi publicado e nenhum direito de uso foi aprovado automaticamente.')
