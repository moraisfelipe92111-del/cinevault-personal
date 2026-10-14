import unittest
import importlib.util
from pathlib import Path

modpath=Path(__file__).resolve().parents[1]/'scripts/enrich-curated-films.py'
spec=importlib.util.spec_from_file_location('cv_enrich',modpath)
cv=importlib.util.module_from_spec(spec)
spec.loader.exec_module(cv)

class ValidateEnrichment(unittest.TestCase):
    def make_movie(self, i):
        return {'tmdbId':i+10000, 'title':f'Title {i}', 'originalTitle':f'Original {i}',
                'year':2000, 'proposedLocalId':318+i,'status':'aguardando_curadoria_humana',
                'reviewTierProposal':'Média','relevanceScoreProposal':100}
    def test_683_selection_rejects_conflicting_id(self):
        movies=[self.make_movie(i) for i in range(683)]
        old=[{'id':i} for i in range(1,318)]
        self.assertEqual(683,len(cv.validate_catalog({'movies':movies},old,{})))
        with self.assertRaises(ValueError):cv.validate_catalog({'movies':movies},old,{'1':10000})
    def test_317_existing_ids_unchanged(self):
        movies=[self.make_movie(i) for i in range(683)]
        old=[{'id':i} for i in range(1,318)]
        old[7]['id']=900
        with self.assertRaises(ValueError):cv.validate_catalog({'movies':movies},old,{})
    def test_film_identity_refused(self):
        film=self.make_movie(0)
        details={'id':10000,'title':'A different movie','original_title':'Something else','release_date':'2000-01-01'}
        self.assertEqual('tmdb_title_mismatch',cv.verify_response(film,details))
        details['title']='Title 0'
        details['release_date']='2020-01-01'
        self.assertEqual('tmdb_release_year_mismatch',cv.verify_response(film,details))
    def test_trailer_filters_and_never_claims_dub_without_title(self):
        vids=[{'site':'YouTube','type':'Trailer','key':'ABCDEFGHIJK','official':True,'name':'Trailer','iso_639_1':'pt','iso_3166_1':'BR'},
              {'site':'YouTube','type':'Trailer','key':'LLLLLLLLLLL','official':True,'name':'Fan made dublado','iso_639_1':'pt','iso_3166_1':'BR'}]
        t=cv.select_video(vids,100)
        self.assertEqual('ABCDEFGHIJK',t['youtubeVideoId'])
        self.assertEqual('unknown',t['dubbedStatus'])
    def test_dub_indication_requires_title(self):
        v=[{'site':'YouTube','type':'Trailer','key':'ABCDEFGHIJK','official':True,'name':'Trailer Oficial Dublado','iso_639_1':'pt','iso_3166_1':'BR'}]
        self.assertEqual('indicated_by_title',cv.select_video(v,100)['dubbedStatus'])
    def test_metadata_preserves_personal_ratings_as_none(self):
        film=self.make_movie(0)
        details={'id':10000,'title':'Title 0','original_title':'Original 0','release_date':'2000-01-01',
                 'poster_path':'/abc.jpg','credits':{'cast':[{'name':'Actor'}],'crew':[{'name':'Director','job':'Director'}]},
                 'runtime':120,'genres':[{'name':'Suspense'}],'overview':'Text'}
        movie=cv.parse_details(film,details,[])
        self.assertEqual('enriched_awaiting_review',movie['status'])
        self.assertIsNone(movie['personalPriority'])
        self.assertIsNone(movie['personalStars'])
        self.assertIsNone(movie['personalizedReason'])
    def test_paths_refuse_traversal(self):
        self.assertIsNone(cv.valid_image_path('/../bad.jpg'))
        self.assertIsNone(cv.valid_image_path('https://evil.example/hi.jpg'))
        self.assertEqual('/good.png',cv.valid_image_path('/good.png'))
    def test_non_latin_original_titles_are_preserved(self):
        self.assertEqual('기생충',cv.normalized('기생충'))
        self.assertEqual('君の名は',cv.normalized('君の名は。'))
    def test_bilingual_original_fallback(self):
        film=self.make_movie(0)
        details={'id':10000,'title':'Localized Title','original_title':'Original 0','release_date':'2000-02-01'}
        self.assertIsNone(cv.verify_response(film,details))

if __name__=='__main__': unittest.main()
