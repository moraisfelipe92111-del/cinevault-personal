#!/usr/bin/env python3
"""CineVault 2.0 — enrich proposed movie data via TMDb; never edit live catalog.

TMDB_READ_ACCESS_TOKEN is consumed only at execution time.  No user / APK data
is modified. The output is review-only and never imports films into src/films.json.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import time
import unicodedata
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

BASE = 'https://api.themoviedb.org/3'
VIDEO_ID = re.compile(r'^[A-Za-z0-9_-]{11}$')
DUB = re.compile(r'\b(dublad[oa]s?|dublagem|dubbed(?: in)? portuguese)\b', re.I)
SUB = re.compile(r'\b(legendad[oa]s?|subtitulado|subtitled|legendas)\b', re.I)
FAN = re.compile(r'\b(fan[ -]?made|fan[ -]?edit|concept|fake|parody|reaction|review|explicad[oa])\b', re.I)
PATH = re.compile(r'^/[A-Za-z0-9_.\-/]+$')


def normalized(s):
    s = unicodedata.normalize('NFKD', str(s or ''))
    normalized_chars = unicodedata.normalize('NFC', ''.join(x for x in s if not unicodedata.combining(x))).lower()
    return ' '.join(''.join(x if x.isalnum() else ' ' for x in normalized_chars).split())


def valid_image_path(value):
    return value if isinstance(value, str) and PATH.fullmatch(value) and '..' not in value and not value.startswith('//') else None


def select_video(raw, tmdb_id):
    """Only YouTube trailers, no autoplay, no assertion of true dubbing."""
    results = []
    seen = set()
    for item in raw:
        if not isinstance(item, dict) or item.get('site') != 'YouTube' or item.get('type') != 'Trailer':
            continue
        key, name = item.get('key'), str(item.get('name') or '')[:160]
        if not isinstance(key, str) or not VIDEO_ID.fullmatch(key) or key in seen or FAN.search(name):
            continue
        seen.add(key)
        lang = str(item.get('iso_639_1') or '').lower()
        region = str(item.get('iso_3166_1') or '').upper()
        pt = lang == 'pt'
        dubbed = bool(pt and DUB.search(name) and not SUB.search(name))
        subtitles = bool(SUB.search(name))
        official = item.get('official') is True
        score = int(official) * 150 + (60 if pt and region == 'BR' else 45 if pt else 0) + int(dubbed) * 40 - int(subtitles) * 12
        if not pt and lang != 'en':
            score -= 8
        results.append((score, str(item.get('published_at') or ''), key,
                        {'tmdbId':tmdb_id, 'youtubeVideoId':key, 'title':name,
                         'provider':'YouTube', 'type':'Trailer', 'language':lang,
                         'region':region, 'official':official,
                         'dubbedStatus':'indicated_by_title' if dubbed else 'unknown',
                         'subtitlesIndicated':subtitles,
                         'checkedAt':datetime.now(timezone.utc).isoformat()}))
    # Highest quality first; use most recent publication for ties.
    if results:
        top=max(results, key=lambda x:(x[0], x[1], x[2]))
        return top[3]
    return None


def validate_catalog(selected, old, ids):
    if not isinstance(old, list) or len(old) != 317 or [v.get('id') for v in old] != list(range(1, 318)):
        raise ValueError('Os 317 IDs originais mudaram; interrompido.')
    proposals = selected.get('movies') if isinstance(selected,dict) else None
    if not isinstance(proposals, list) or len(proposals) != 683:
        raise ValueError('Esperada a lista da Fase B com exatamente 683 candidatos')
    excluded = {v for v in ids.values() if type(v) is int and v > 0}
    seen = set()
    for i, movie in enumerate(proposals):
        if not isinstance(movie,dict):
            raise ValueError('Candidato inválido')
        tmdbid = movie.get('tmdbId')
        if type(tmdbid) is not int or tmdbid < 1 or tmdbid in seen or tmdbid in excluded:
            raise ValueError('ID TMDb já usado ou duplicado na seleção')
        seen.add(tmdbid)
        if movie.get('proposedLocalId') != i+318 or movie.get('status') != 'aguardando_curadoria_humana':
            raise ValueError('ID local proposto ou status inesperado')
        if type(movie.get('year')) is not int or not 1950<=movie['year']<=2026:
            raise ValueError('Ano inválido')
        if not normalized(movie.get('title')) or not normalized(movie.get('originalTitle')):
            raise ValueError('Título inválido')
    return proposals


def verify_response(movie, detail):
    tmdb_id=movie['tmdbId']
    if not isinstance(detail, dict) or detail.get('id') != tmdb_id or detail.get('adult') is True:
        return 'tmdb_identity_mismatch'
    date=str(detail.get('release_date') or '')
    if not re.match(r'^\d{4}-\d{2}-\d{2}$',date) or abs(int(date[:4])-movie['year'])>1:
        return 'tmdb_release_year_mismatch'
    names={normalized(movie.get('title')), normalized(movie.get('originalTitle'))}
    actual={normalized(detail.get('title')),normalized(detail.get('original_title'))}
    if not (names & actual):
        return 'tmdb_title_mismatch'
    return None


def parse_details(movie, detail, videos):
    issue=verify_response(movie, detail)
    if issue:
        return {'tmdbId':movie['tmdbId'], 'proposedLocalId':movie['proposedLocalId'],
                'title':movie['title'], 'status':'requires_identity_review', 'issue':issue}
    credits=detail.get('credits') if isinstance(detail.get('credits'),dict) else {}
    directors=[x.get('name') for x in credits.get('crew',[]) if isinstance(x,dict) and x.get('job')=='Director' and isinstance(x.get('name'),str)]
    cast=[x.get('name') for x in credits.get('cast',[]) if isinstance(x,dict) and isinstance(x.get('name'),str)]
    runtime=detail.get('runtime')
    if type(runtime) is not int or not 30<=runtime<=360:runtime=None
    trailer=select_video(videos,movie['tmdbId'])
    required=[]
    if not directors:required.append('director')
    if not cast:required.append('actors')
    if runtime is None:required.append('runtime')
    if not trailer:required.append('trailer')
    poster=valid_image_path(detail.get('poster_path'))
    if not poster:required.append('poster')
    required.extend(['personalized_reason','personal_priority'])
    return {
        'tmdbId':movie['tmdbId'],'proposedLocalId':movie['proposedLocalId'],
        'title':detail.get('title') or movie['title'],
        'originalTitle':detail.get('original_title') or movie.get('originalTitle'),
        'year':int(str(detail['release_date'])[:4]),
        'overviewTmdb':str(detail.get('overview') or '')[:3000],
        'posterPathTmdb':poster,
        'backdropPathTmdb':valid_image_path(detail.get('backdrop_path')),
        'genreNames':[x['name'] for x in detail.get('genres',[]) if isinstance(x,dict) and isinstance(x.get('name'),str)],
        'director':'; '.join(dict.fromkeys(directors)),
        'actors':'; '.join(dict.fromkeys(cast[:6])),
        'runtimeMinutes':runtime,
        'tmdbVoteAverage':detail.get('vote_average'),
        'tmdbVoteCount':detail.get('vote_count'),
        'trailer':trailer,
        'personalStars':None,'personalPriority':None,'personalizedReason':None,
        'reviewTierProposal':movie['reviewTierProposal'],
        'relevanceScoreProposal':movie['relevanceScoreProposal'],
        'status':'enriched_awaiting_review',
        'metadataPending':required,
        'checkedAt':datetime.now(timezone.utc).isoformat(),
    }


def fetch_json(token, path, params=None):
    url=BASE+path+('?' + urlencode(params) if params else '')
    for attempt in range(4):
        req=Request(url,headers={'Authorization':f'Bearer {token}','Accept':'application/json','User-Agent':'CineVaultMetaBuilder/2.0'})
        try:
            with urlopen(req, timeout=20) as rsp:
                if rsp.status != 200:raise RuntimeError(f'TMDb HTTP {rsp.status}')
                data=json.load(rsp)
                if not isinstance(data,dict):raise RuntimeError('JSON TMDb inválido')
                return data
        except HTTPError as exc:
            if exc.code in (401,403):raise RuntimeError('TMDb: acesso negado (confira o segredo)') from None
            if exc.code not in (429,500,502,503,504) or attempt==3:raise RuntimeError(f'TMDb HTTP {exc.code}') from None
            delay=min(15,2**attempt*2)
            value=exc.headers.get('Retry-After') if exc.headers else None
            if value and value.isdigit():delay=min(15,max(delay,int(value)))
            time.sleep(delay)
        except (URLError,TimeoutError) as exc:
            if attempt==3:raise RuntimeError('TMDb: rede indisponível/timeout') from None
            time.sleep(2**attempt)
    raise RuntimeError('TMDb sem resposta')


def enrich_one(movie, token):
    tmdbid=movie['tmdbId']
    try:
        detail=fetch_json(token,f'/movie/{tmdbid}',{'language':'pt-BR','append_to_response':'credits,videos'})
        issue=verify_response(movie,detail)
        if issue:return {'tmdbId':tmdbid,'proposedLocalId':movie['proposedLocalId'],'title':movie['title'],'status':'requires_identity_review','issue':issue}
        br=detail.get('videos',{}).get('results',[]) if isinstance(detail.get('videos'),dict) else []
        eng=fetch_json(token,f'/movie/{tmdbid}/videos',{'language':'en-US'}).get('results',[])
        return parse_details(movie,detail,(br if isinstance(br,list) else [])+(eng if isinstance(eng,list) else []))
    except Exception as e:
        if 'acesso negado' in str(e):
            raise
        return {'tmdbId':tmdbid,'proposedLocalId':movie['proposedLocalId'],'title':movie['title'],
                'status':'retry_required','issue':str(e)[:180]}


def run(root:Path, selected_file:Path, outdir:Path, limit:int, token:str, workers:int=3):
    if not token:raise ValueError('TMDB_READ_ACCESS_TOKEN não configurado')
    if not 1<=limit<=683:raise ValueError('Limite deve estar entre 1 e 683')
    films=json.loads((root/'src/films.json').read_text(encoding='utf-8'))
    ids=json.loads((root/'src/movieTmdbIds.json').read_text(encoding='utf-8'))
    raw=selected_file.read_bytes()
    selected=json.loads(raw)
    proposals=validate_catalog(selected, films, ids)[:limit]
    results=[None]*len(proposals)
    with ThreadPoolExecutor(max_workers=min(workers,4)) as pool:
        tasks={pool.submit(enrich_one,v,token):i for i,v in enumerate(proposals)}
        for n,future in enumerate(as_completed(tasks),1):
            i=tasks[future];results[i]=future.result()
            if n%25==0 or n==len(proposals):
                print(f'Enriquecimento: {n}/{len(proposals)} consultados',flush=True)
    count=lambda name:sum(x.get('status')==name for x in results)
    summary={'sourceSha256':hashlib.sha256(raw).hexdigest(),'checked':len(results),
             'enrichedAwaitingReview':count('enriched_awaiting_review'),
             'identityReviewRequired':count('requires_identity_review'),
             'retryRequired':count('retry_required'),
             'withTrailer':sum(bool(x.get('trailer')) for x in results),
             'withPoster':sum(bool(x.get('posterPathTmdb')) for x in results),
             'originalCatalogCount':317,'catalogChanged':False,
             'reviewRequired':True,'generatedAt':datetime.now(timezone.utc).isoformat()}
    outdir.mkdir(parents=True,exist_ok=True)
    outputs={'cinevault2-enriched-review.json':{'metadata':summary,'movies':results},'cinevault2-enrichment-stats.json':summary}
    for name,value in outputs.items():
        file=outdir/name
        tmp=file.with_suffix(file.suffix+'.tmp')
        tmp.write_text(json.dumps(value,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
        tmp.replace(file)
    print('CINEVAULT 2.0 — METADADOS PARA REVISAO',json.dumps(summary,ensure_ascii=False),flush=True)
    if summary['enrichedAwaitingReview'] == 0:
        raise RuntimeError('Nenhum registro verificado. Pare antes de importar qualquer dado.')


def main():
    ap=argparse.ArgumentParser()
    ap.add_argument('--root',type=Path,default=Path('.'))
    ap.add_argument('--selected',type=Path,default=Path('planning/cinevault2-selected-683.json'))
    ap.add_argument('--output',type=Path,default=Path('planning/enrichment-results'))
    ap.add_argument('--limit',type=int,default=683)
    ap.add_argument('--workers',type=int,default=3)
    args=ap.parse_args()
    token=os.environ.get('TMDB_READ_ACCESS_TOKEN','').strip()
    run(args.root,args.selected,args.output,args.limit,token,args.workers)

if __name__=='__main__':
    main()
