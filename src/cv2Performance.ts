/** CineVault 2.0 — helpers puros, sem rede e sem acesso ao armazenamento. */
export type SearchableFilm = {id:number;title:string;genre:string;director:string;actors:string;year:number}
export type PrioritizedFilm = {priority:string}
export type IdentifiedFilm = {id:number}

export function normalizeFilmSearch(value: string | number):string {
  return String(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR')
}

/** Calculado uma única vez para o catálogo, em vez de reconstruído a cada tecla. */
export function buildFilmSearchIndex<T extends SearchableFilm>(films:readonly T[]):ReadonlyMap<number,string> {
  return new Map(films.map(f=>[f.id, normalizeFilmSearch([f.title,f.genre,f.director,f.actors,f.year].join(' '))]))
}

/** Prioridade N significa não avaliado, jamais uma recomendação personalizada. */
export function personalCurationOnly<T extends PrioritizedFilm>(films:readonly T[]):T[] {
  return films.filter(f=>f.priority!=='N')
}

/** Capas TMDb resolvidas no catálogo + vínculos salvos pelo usuário. */
export function countLinkedCovers<T extends IdentifiedFilm>(films:readonly T[], urls:Readonly<Record<string,string>>):number {
  return films.reduce((n,f)=>n+(typeof urls[f.id]==='string'&&urls[f.id].length>0?1:0),0)
}
