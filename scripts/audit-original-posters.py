#!/usr/bin/env python3
"""CineVault 2.0 F3A: fetch original-catalog poster links for review only.

Read-only inputs: src/films.json, src/movieTmdbIds.json.
Outputs only under an explicitly supplied review directory.
No edits to src, no APK work, no image downloading, and no credential output.
"""
from __future__ import annotations

import argparse
import datetime
import json
import os
import re
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Callable

TMDB_HOST = 'https://api.themoviedb.org/3'
POSTER_BASE = 'https://image.tmdb.org/t/p/w500'
POSTER_PATH = re.compile(r'^/[A-Za-z0-9_-]{5,100}\.(?:jpg|jpeg|png|webp)$', re.I)


def normalize(value: object) -> str:
    text = unicodedata.normalize('NFKD', str(value or ''))
    text = ''.join(c for c in text if not unicodedata.combining(c))
    return re.sub(r'[^a-z0-9]+', ' ', text.lower()).strip()


def aliases(title: str) -> list[str]:
    """Extract primary and explicitly parenthesized alternate movie titles."""
    titles = [title]
    without_parentheses = re.sub(r'\s*\([^()]*\)', '', title).strip()
    if without_parentheses:
        titles.append(without_parentheses)
    for part in re.findall(r'\(([^()]*)\)', title):
        if part.strip():
            titles.extend(p.strip() for p in part.split('/') if p.strip())
    return list(dict.fromkeys(t for t in titles if len(normalize(t)) >= 3))


def year_of(movie: dict) -> int | None:
    date = movie.get('release_date') or ''
    return int(date[:4]) if isinstance(date, str) and re.fullmatch(r'\d{4}-\d{2}-\d{2}', date) else None


def sane_poster(path: object) -> str | None:
    if isinstance(path, str) and POSTER_PATH.fullmatch(path):
        return POSTER_BASE + path
    return None


def known_match(local: dict, tmdb: dict, intended_id: int) -> bool:
    if tmdb.get('id') != intended_id or tmdb.get('adult') is True:
        return False
    release_year = year_of(tmdb)
    return release_year is not None and abs(release_year - local['year']) <= 1


def search_match(local: dict, choices: list[dict]) -> tuple[dict | None, str]:
    """Conservative candidate selection: exact title/alias + ±1 year + unique TMDb ID.

    Do not silently attach a nearby title or different remake.
    """
    approved = []
    expected = {normalize(a) for a in aliases(local['title'])}
    for movie in choices:
        if not isinstance(movie, dict) or movie.get('adult') is True:
            continue
        mid = movie.get('id')
        if not isinstance(mid, int) or mid <= 0:
            continue
        year = year_of(movie)
        if year is None or abs(year - local['year']) > 1:
            continue
        found_titles = {normalize(movie.get('title')), normalize(movie.get('original_title'))}
        if not (expected & found_titles):
            continue
        approved.append(movie)
    unique = {m['id']: m for m in approved}
    if not unique:
        return None, 'no_safe_identity'
    if len(unique) != 1:
        return None, 'ambiguous_identity'
    return next(iter(unique.values())), 'unmapped_exact_title_year'


def request_tmdb(token: str, endpoint: str, params: dict | None = None) -> dict:
    if not endpoint.startswith('/') or '://' in endpoint or '\\' in endpoint:
        raise ValueError('TMDb endpoint inválido')
    query = urllib.parse.urlencode(params or {}, doseq=False)
    url = TMDB_HOST + endpoint + ('?' + query if query else '')
    last_error: Exception | None = None
    for attempt in range(4):
        req = urllib.request.Request(url, headers={
            'Authorization': 'Bearer ' + token,
            'Accept': 'application/json',
            'User-Agent': 'CineVault-Original-Poster-Audit/1.0',
        })
        try:
            with urllib.request.urlopen(req, timeout=13) as response:
                if response.geturl().split('/')[2].lower() != 'api.themoviedb.org':
                    raise RuntimeError('Resposta fora do domínio TMDb')
                raw = response.read(1_000_001)
                if len(raw) > 1_000_000:
                    raise RuntimeError('Resposta TMDb excessivamente grande')
                obj = json.loads(raw)
                if not isinstance(obj, dict):
                    raise RuntimeError('Resposta TMDb inesperada')
                return obj
        except urllib.error.HTTPError as exc:
            if exc.code in (401, 403):
                raise RuntimeError('Token TMDb inválido ou sem permissão (401/403).') from None
            if exc.code not in (429, 500, 502, 503, 504) or attempt == 3:
                raise RuntimeError(f'Consulta TMDb retornou HTTP {exc.code}.') from None
            last_error = exc
            retry_after = exc.headers.get('Retry-After')
            try:
                wait = min(15, max(1, float(retry_after))) if retry_after else 1.5 * (attempt + 1)
            except ValueError:
                wait = 1.5 * (attempt + 1)
            time.sleep(wait)
        except (TimeoutError, urllib.error.URLError) as exc:
            if attempt == 3:
                raise RuntimeError('TMDb temporariamente inacessível.') from None
            last_error = exc
            time.sleep(1.5 * (attempt + 1))
    raise RuntimeError('Falha persistente na consulta TMDb') from last_error


def validate_inputs(films: object, ids: object) -> tuple[list[dict], dict]:
    if not isinstance(films, list) or len(films) != 317:
        raise ValueError('Esperados exatamente 317 filmes originais.')
    if [f.get('id') for f in films] != list(range(1, 318)):
        raise ValueError('IDs originais 1–317 devem permanecer em ordem.')
    for f in films:
        if not isinstance(f.get('title'), str) or not f['title'].strip() or not isinstance(f.get('year'), int) or not (1890 <= f['year'] <= 2030):
            raise ValueError('Metadados de filme original inválidos.')
    if not isinstance(ids, dict) or len(ids) < 200:
        raise ValueError('Mapa de identidades TMDb existente inesperado.')
    if not set(ids).issubset({str(i) for i in range(1, 318)}):
        raise ValueError('Mapa TMDb contém IDs de filmes não originais.')
    if any(not isinstance(v, int) or v <= 0 for v in ids.values()):
        raise ValueError('ID TMDb inválido.')
    return films, ids


def audit(films: list[dict], ids: dict, fetch: Callable[[str, dict | None], dict]):
    original_tmdbs = set(ids.values())
    linked, statuses, proposed_ids = {}, {}, {}
    for index, film in enumerate(films, 1):
        key = str(film['id'])
        known = ids.get(key)
        record = {'id': film['id'], 'title': film['title'], 'year': film['year'], 'tmdbId': known,
                  'result': 'pending', 'reason': None}
        try:
            if known:
                detail = fetch(f'/movie/{known}', {'language': 'pt-BR'})
                if not known_match(film, detail, known):
                    record['reason'] = 'linked_identity_year_mismatch'
                else:
                    url = sane_poster(detail.get('poster_path'))
                    if url:
                        linked[key] = url
                        record['result'], record['reason'] = 'linked', 'existing_verified_tmdb_id'
                    else:
                        record['reason'] = 'no_safe_poster_path'
            else:
                seen, found = set(), []
                for name in aliases(film['title']):
                    matches = fetch('/search/movie', {'query': name, 'language': 'pt-BR',
                                                      'include_adult': 'false', 'page': 1})
                    for m in matches.get('results', []):
                        if not isinstance(m, dict):
                            continue
                        mid = m.get('id')
                        if mid not in seen:
                            seen.add(mid)
                            found.append(m)
                chosen, why = search_match(film, found)
                if chosen and chosen['id'] in original_tmdbs:
                    record['reason'] = 'tmdb_id_already_used'
                elif chosen:
                    detail = fetch(f"/movie/{chosen['id']}", {'language': 'pt-BR'})
                    # Confirm details again; never accept only a search snippet.
                    if not known_match(film, detail, chosen['id']):
                        record['reason'] = 'candidate_identity_year_mismatch'
                    else:
                        url = sane_poster(detail.get('poster_path'))
                        if url:
                            linked[key] = url
                            proposed_ids[key] = chosen['id']
                            original_tmdbs.add(chosen['id'])
                            record['tmdbId'] = chosen['id']
                            record['result'], record['reason'] = 'linked', why
                        else:
                            record['reason'] = 'no_safe_poster_path'
                else:
                    record['reason'] = why
        except (ValueError, RuntimeError, TypeError) as exc:
            # Fail closed per film and leave an audit trail; never leak token.
            record['reason'] = 'tmdb_request_failed'
            record['errorType'] = type(exc).__name__
        statuses[key] = record
        if index % 25 == 0 or index == len(films):
            print(f'Capas originais: {index}/{len(films)} consultadas', flush=True)

    stats = {'catalogCount': len(films), 'posterLinks': len(linked),
             'existingMappedIds': len(ids), 'proposedNewTmdbIds': len(proposed_ids),
             'unresolved': len(films) - len(linked), 'catalogChanged': False,
             'previewOnly': True, 'source': 'TMDb',
             'generatedAt': datetime.datetime.now(datetime.timezone.utc).isoformat()}
    return linked, statuses, proposed_ids, stats


def run(project: Path, out: Path, token: str) -> dict:
    project, out = project.resolve(), out.resolve()
    if out == project or out == project / 'src' or project / 'src' in out.parents:
        raise ValueError('A saída não pode sobrescrever arquivos de src/.')
    films = json.loads((project / 'src/films.json').read_text(encoding='utf-8'))
    ids = json.loads((project / 'src/movieTmdbIds.json').read_text(encoding='utf-8'))
    films, ids = validate_inputs(films, ids)
    if not token or len(token) < 20:
        raise ValueError('TMDB_READ_ACCESS_TOKEN não configurado no GitHub.')
    posters, audit_log, proposal, summary = audit(films, ids, lambda e, p: request_tmdb(token, e, p))
    out.mkdir(parents=True, exist_ok=True)
    for filename, data in [
        ('cinevault2-original-posters.json', posters),
        ('cinevault2-original-posters-audit.json', {'stats': summary, 'movies': list(audit_log.values())}),
        ('cinevault2-original-tmdb-id-proposals.json', proposal),
    ]:
        (out / filename).write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print('CINEVAULT F3A: '+json.dumps(summary, ensure_ascii=False), flush=True)
    return summary


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--project', type=Path, default=Path('.'))
    parser.add_argument('--output', type=Path, default=Path('planning/cv2-posters-review'))
    args = parser.parse_args()
    run(args.project, args.output, os.environ.get('TMDB_READ_ACCESS_TOKEN', ''))
