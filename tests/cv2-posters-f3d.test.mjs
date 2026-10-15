
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),'..'
);

const read=name=>JSON.parse(
  fs.readFileSync(path.join(root,name),'utf8')
);

const before=read('tests/fixtures/catalogPosters-f3c.json');
const after=read('src/catalogPosters.json');
const films=read('src/films.json');

const expected=[
  6,63,78,92,112,134,136,137,
  225,234,249,255,264,281,290
];

test('F3D preserva todos os 985 posters anteriores',()=>{
  assert.equal(Object.keys(before).length,985);

  for(const [id,url] of Object.entries(before)){
    assert.equal(after[id],url,`Poster alterado: ${id}`);
  }
});

test('F3D adiciona somente os 15 IDs auditados',()=>{
  const added=Object.keys(after)
    .filter(id=>!(id in before))
    .map(Number).sort((a,b)=>a-b);

  assert.deepEqual(added,expected);

  const valid=/^https:\/\/image\.tmdb\.org\/t\/p\/w500\/[^\s?#]+\.(jpg|jpeg|png|webp)$/i;

  for(const id of expected){
    assert.match(after[id],valid);
  }
});

test('F3D cobre exatamente os 1000 filmes',()=>{
  assert.equal(films.length,1000);
  assert.equal(Object.keys(after).length,1000);

  for(const film of films){
    assert.equal(typeof after[film.id],'string');
    assert.ok(after[film.id].length>0);
  }

  const ids=Object.keys(after).map(Number);

  assert.equal(ids.filter(id=>id<=317).length,317);
  assert.equal(ids.filter(id=>id>=318).length,683);
});
