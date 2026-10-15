import importlib.util
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts' / 'audit-original-posters.py'
spec = importlib.util.spec_from_file_location('cv_f3_posters', SCRIPT)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


def movie(id, title='Filme Original', year=2000):
    return {'id': id, 'title': title, 'year': year}


def detail(id, title='Filme Original', year=2000, poster='/abcEF012345.jpg'):
    return {'id': id, 'title': title, 'release_date': f'{year}-08-12', 'poster_path': poster,
            'adult': False}


class PosterAuditTests(unittest.TestCase):
    def test_known_id_accepts_verified_year(self):
        p, s, prop, stats = m.audit([movie(1)], {'1': 123},
            lambda e, args: detail(123))
        self.assertEqual(p['1'], 'https://image.tmdb.org/t/p/w500/abcEF012345.jpg')
        self.assertEqual(stats['posterLinks'], 1)
        self.assertEqual(prop, {})

    def test_known_wrong_year_fails_closed(self):
        p, s, prop, stats = m.audit([movie(1)], {'1': 123},
            lambda e, args: detail(123, year=1994))
        self.assertEqual(p, {})
        self.assertEqual(s['1']['reason'], 'linked_identity_year_mismatch')

    def test_malicious_path_rejected(self):
        for path in ['/../secret.jpg', '/https://evil.com/p.jpg', '/bad.svg', '/a.jpg?x=1']:
            self.assertIsNone(m.sane_poster(path))

    def test_unmapped_exact_match_can_propose_id(self):
        def fetch(e, args):
            return {'results':[detail(333)]} if e.startswith('/search/') else detail(333)
        p, s, prop, stats = m.audit([movie(1)], {}, fetch)
        self.assertEqual(prop, {'1': 333})
        self.assertEqual(len(p), 1)

    def test_remake_wrong_year_does_not_match(self):
        chosen, cause = m.search_match(movie(1), [detail(222, year=2011)])
        self.assertIsNone(chosen)
        self.assertEqual(cause, 'no_safe_identity')

    def test_ambiguous_exact_matches_not_attached(self):
        chosen, cause = m.search_match(movie(1), [detail(222), detail(223)])
        self.assertIsNone(chosen)
        self.assertEqual(cause, 'ambiguous_identity')

    def test_other_existing_tmdb_id_cannot_be_reused(self):
        films = [movie(1), movie(2)]
        def fetch(e, args):
            return {'results':[detail(123)]} if e.startswith('/search') else detail(123)
        linked, report, proposed, stats = m.audit(films, {'1': 123}, fetch)
        self.assertEqual(set(linked), {'1'})
        self.assertEqual(report['2']['reason'], 'tmdb_id_already_used')

    def test_network_error_only_marks_item_pending(self):
        posters, results, _, stats = m.audit([movie(1)], {'1':123},
            lambda e, args: (_ for _ in ()).throw(RuntimeError('api offline')))
        self.assertEqual(posters, {})
        self.assertEqual(results['1']['reason'], 'tmdb_request_failed')
        self.assertEqual(stats['unresolved'], 1)

    def test_aliases_preserve_alternative_titles(self):
        expected = m.aliases('O Incrível Filme (The Great Movie / A Outra Versão)')
        self.assertIn('The Great Movie', expected)
        self.assertIn('A Outra Versão', expected)

    def test_unmapped_nonmatching_title_rejected(self):
        target = movie(1, 'O Mistério')
        self.assertEqual(m.search_match(target, [detail(201, 'Outro Título')])[0], None)

    def test_input_validation_317_strict(self):
        records=[movie(i) for i in range(1,318)]
        ids={str(i):i+1000 for i in range(1,301)}
        self.assertEqual(len(m.validate_inputs(records, ids)[0]), 317)
        with self.assertRaises(ValueError):m.validate_inputs(records[:-1],ids)
        with self.assertRaises(ValueError):m.validate_inputs(records, {'999':333})

    def test_output_protects_src(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp)
            with self.assertRaises((ValueError, FileNotFoundError)):
                m.run(root,root/'src', 'a'*50)

if __name__ == '__main__':unittest.main()
