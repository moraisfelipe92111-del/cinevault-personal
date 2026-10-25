import {episodePosition, parseMediaKey, validateMediaKey, type MediaKey} from './mediaIdentity.ts'
import {setEpisodeWatched, setMediaStatus, validateMediaProgressSnapshot, type MediaProgressSnapshot, type MediaStatus} from './mediaProgress.ts'

export type MediaProgressEdit = Readonly<{type: 'status'; status: MediaStatus}> |
  Readonly<{type: 'episode'; season: number; episode: number; watched: boolean}> | Readonly<{type: 'remove'}>

/** A queued edit changes one identity and retains every other imported or unmapped record. */
export function editMediaProgress(input: unknown, identity: MediaKey, edit: MediaProgressEdit): MediaProgressSnapshot {
  const snapshot = validateMediaProgressSnapshot(input), key = validateMediaKey(identity)
  const fields = edit?.type === 'status' ? ['type','status'] : edit?.type === 'episode' ? ['type','season','episode','watched'] : ['type']
  if (!edit || typeof edit !== 'object' || Array.isArray(edit) || Object.keys(edit).length !== fields.length || fields.some(field => !Object.hasOwn(edit,field)))
    throw new Error('Alteração de acompanhamento inválida.')
  const current = snapshot.entries.find(entry => entry.key === key)
  if (edit.type === 'remove') return validateMediaProgressSnapshot({...snapshot, entries: snapshot.entries.filter(entry => entry.key !== key)})
  const initial = current ?? {key, status: 'want_to_watch' as const, watchedEpisodes: []}
  let next
  if (edit.type === 'status') next = setMediaStatus(initial, edit.status)
  else if (edit.type === 'episode') {
    if (parseMediaKey(key).mediaType !== 'tv') throw new Error('Esse conteúdo não possui episódios.')
    next = setEpisodeWatched(initial, edit.season, edit.episode, edit.watched)
    if (edit.watched && (!current || current.status === 'want_to_watch')) next = setMediaStatus(next, 'watching')
    if (!edit.watched && !current) return snapshot
  } else throw new Error('Alteração de acompanhamento inválida.')
  return validateMediaProgressSnapshot({...snapshot, entries: current ? snapshot.entries.map(entry => entry.key === key ? next : entry) : [...snapshot.entries, next]})
}

export function episodeInputs(season: string, episode: string) {
  if (!/^(0|[1-9][0-9]*)$/.test(season) || !/^[1-9][0-9]*$/.test(episode)) throw new Error('Informe uma temporada e um episódio inteiros. Temporada 0 representa especiais.')
  return episodePosition(Number(season), Number(episode))
}
