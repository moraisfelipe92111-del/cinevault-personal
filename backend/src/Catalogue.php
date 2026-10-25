<?php
declare(strict_types=1);
namespace Sintonema\Admin;

final class Catalogue
{
    private array $aliases=[];
    public function __construct(private readonly Database $db, private readonly array $legacy)
    {
        foreach ($legacy as $id=>$record) {
            foreach ($record['aliases']??[] as $alias) {
                requireValue(is_string($alias) && preg_match('/^tmdb:movie:[1-9][0-9]*$/D',$alias)===1 && !isset($this->aliases[$alias]),
                    'Registro de compatibilidade inválido.',503);
                $this->aliases[$alias]='local:movie:'.$id;
            }
        }
    }
    private function text(mixed $value, int $max): string
    {
        requireValue(is_string($value) && strlen($value)>0 && strlen($value)<=$max && preg_match('//u',$value)===1 &&
            !preg_match('/[\x00-\x1f\x7f<>]/u',$value), 'Texto de catálogo inválido.');
        return $value;
    }
    public function validate(mixed $input): array
    {
        requireValue(exactObject($input,['format','version','mode','items']) && $input['format']==='sintonema.catalogue' &&
            $input['version']===1 && $input['mode']==='supplement', 'Formato de catálogo incompatível.');
        requireValue(is_array($input['items']) && array_is_list($input['items']) && count($input['items'])>=1 && count($input['items'])<=10000,
            'O catálogo precisa de 1 a 10.000 títulos.');
        $items=[]; $seen=[];
        foreach ($input['items'] as $item) {
            requireValue(exactObject($item,['key','title','year','kind','categories','posterUrl','sourceUrl','attribution']), 'Campos de título inválidos.');
            $key = $item['key'];
            requireValue(is_string($key) && (bool)preg_match('/^(local|tmdb|tvmaze):(movie|tv):([1-9][0-9]{0,9})$/D',$key,$identity) &&
                !isset($seen[$key]), 'Identidade inválida ou duplicada.');
            $seen[$key]=true; $id=(int)$identity[3]; $provider=$identity[1]; $type=$identity[2];
            requireValue(!isset($this->aliases[$key]), 'Este filme já pertence ao catálogo local. Use sua identidade local preservada.');
            requireValue(($type==='movie' && in_array($item['kind'],['movie','short','special'],true)) ||
                ($type==='tv' && $item['kind']==='series'), 'Tipo incompatível com a identidade.');
            requireValue($item['year']===null || (is_int($item['year']) && $item['year']>=1888 && $item['year']<=2200), 'Ano inválido.');
            $title=$this->text($item['title'],300); $attribution=$this->text($item['attribution'],500);
            requireValue(is_array($item['categories']) && array_is_list($item['categories']) && count($item['categories'])<=8 &&
                count(array_unique($item['categories'],SORT_REGULAR))===count($item['categories']), 'Categorias inválidas.');
            foreach ($item['categories'] as $category) {
                requireValue(in_array($category,['fiction','anime','reality','documentary','animation','soap','children','other'],true), 'Categoria não suportada.');
            }
            $source=$item['sourceUrl']; $poster=$item['posterUrl'];
            if ($provider==='local') {
                requireValue($type==='movie' && isset($this->legacy[(string)$id]) &&
                    $this->legacy[(string)$id]['title']===$title && $this->legacy[(string)$id]['year']===$item['year'],
                    'A identidade de um filme local não pode ser trocada pelo painel.');
                requireValue($source===null, 'Filmes locais não recebem aliases presumidos.');
            } elseif ($provider==='tmdb') {
                requireValue(is_string($source) && $source==='https://www.themoviedb.org/'.($type==='tv'?'tv':'movie').'/'.$id,
                    'A fonte precisa corresponder à identidade TMDb.');
            } else {
                requireValue($type==='tv' && is_string($source) &&
                    (bool)preg_match('~^https://www\.tvmaze\.com/shows/'.$id.'/[a-z0-9-]+$~D',$source), 'A fonte precisa corresponder à identidade TVmaze.');
            }
            requireValue($poster===null || (is_string($poster) &&
                (preg_match('~^https://image\.tmdb\.org/t/p/w500/[a-zA-Z0-9_-]+\.(?:jpg|png)$~D',$poster) ||
                preg_match('~^https://static\.tvmaze\.com/uploads/images/(?:medium_portrait|original_untouched)/[0-9]+/[a-zA-Z0-9_-]+\.(?:jpg|png)$~D',$poster))),
                'Imagem não canônica ou não suportada.');
            $categories=$item['categories']; sort($categories,SORT_STRING);
            $items[]=['key'=>$key,'title'=>$title,'year'=>$item['year'],'kind'=>$item['kind'],'categories'=>$categories,
                'posterUrl'=>$poster,'sourceUrl'=>$source,'attribution'=>$attribution];
        }
        usort($items,fn(array $a,array $b):int=>strcmp($a['key'],$b['key']));
        $catalogue=['format'=>'sintonema.catalogue','version'=>1,'mode'=>'supplement','items'=>$items];
        requireValue(strlen(jsonText($catalogue))<=4*1024*1024, 'Catálogo acima do limite.');
        return $catalogue;
    }
    private function decodeRow(array $row): array
    {
        requireValue(hash_equals($row['digest'],hash('sha256',$row['payload'])), 'Catálogo preservado com integridade inválida.', 503);
        $value=json_decode($row['payload'],true,64,JSON_THROW_ON_ERROR); $validated=$this->validate($value);
        requireValue(jsonText($validated)===$row['payload'] && count($validated['items'])===(int)$row['item_count'], 'Catálogo preservado inconsistente.', 503);
        return $validated;
    }
    public function create(mixed $catalogue, string $title, string $actor, int $now): array
    {
        $payload=jsonText($this->validate($catalogue)); $title=$this->text($title,120);
        return $this->db->transaction(function () use ($payload,$title,$actor,$now): array {
            $this->db->execute('INSERT INTO sn_drafts (revision,title,payload,digest,item_count,updated_at) VALUES (1,?,?,?,?,?)',
                [$title,$payload,hash('sha256',$payload),count(json_decode($payload,true)['items']),$now]);
            $id=(int)$this->db->pdo->lastInsertId(); $this->db->audit('draft_created',$actor,$id,$now);
            return $this->draft($id);
        });
    }
    public function draft(int $id): array
    {
        positive($id); $row=$this->db->query('SELECT * FROM sn_drafts WHERE id=?',[$id])[0]??null;
        requireValue($row!==null,'Rascunho não encontrado.',404);
        return ['id'=>(int)$row['id'],'revision'=>(int)$row['revision'],'title'=>$row['title'],'digest'=>$row['digest'],
            'catalogue'=>$this->decodeRow($row),'updatedAt'=>(int)$row['updated_at']];
    }
    public function update(int $id, int $revision, mixed $input, string $title, string $actor, int $now): array
    {
        positive($id); positive($revision); $value=$this->validate($input); $title=$this->text($title,120); $payload=jsonText($value);
        return $this->db->transaction(function () use ($id,$revision,$payload,$title,$value,$actor,$now): array {
            $row=$this->db->query('SELECT * FROM sn_drafts WHERE id=? FOR UPDATE',[$id])[0]??null;
            requireValue($row!==null,'Rascunho não encontrado.',404); $this->decodeRow($row);
            requireValue((int)$row['revision']===$revision,'Este rascunho mudou. Recarregue antes de salvar.',409);
            if ($row['payload']===$payload && $row['title']===$title) { return $this->draft($id); }
            $this->db->execute('UPDATE sn_drafts SET revision=revision+1,title=?,payload=?,digest=?,item_count=?,updated_at=? WHERE id=? AND revision=?',
                [$title,$payload,hash('sha256',$payload),count($value['items']),$now,$id,$revision]);
            $this->db->audit('draft_updated',$actor,$id,$now); return $this->draft($id);
        });
    }
    public function review(int $id, int $revision, string $digest, mixed $checks, string $actor, int $now): array
    {
        positive($id); positive($revision);
        requireValue(exactObject($checks,['identity','metadataRights','imageRights']) &&
            $checks['identity']===true && $checks['metadataRights']===true && $checks['imageRights']===true,
            'Confirme identidade, direitos dos dados e das imagens antes de revisar.');
        return $this->db->transaction(function () use ($id,$revision,$digest,$actor,$now): array {
            $row=$this->db->query('SELECT * FROM sn_drafts WHERE id=? FOR UPDATE',[$id])[0]??null;
            requireValue($row!==null,'Rascunho não encontrado.',404); $this->decodeRow($row);
            requireValue((int)$row['revision']===$revision && hash_equals($row['digest'],$digest), 'A revisão não corresponde ao rascunho atual.',409);
            $this->db->execute('INSERT IGNORE INTO sn_reviews (draft_id,draft_revision,digest,actor,reviewed_at) VALUES (?,?,?,?,?)',[$id,$revision,$digest,$actor,$now]);
            $this->db->audit('draft_reviewed',$actor,$id,$now);
            return ['draftId'=>$id,'revision'=>$revision,'digest'=>$digest];
        });
    }
    public function publish(int $id, int $revision, int $generation, string $actor, int $now): array
    {
        positive($id); positive($revision); positive($generation,true);
        return $this->db->transaction(function () use ($id,$revision,$generation,$actor,$now): array {
            $head=$this->db->query('SELECT * FROM sn_head WHERE id=1 FOR UPDATE')[0]??null;
            requireValue($head!==null && (int)$head['generation']===$generation, 'A publicação mudou. Recarregue antes de publicar.',409);
            $row=$this->db->query('SELECT * FROM sn_drafts WHERE id=? FOR UPDATE',[$id])[0]??null;
            requireValue($row!==null,'Rascunho não encontrado.',404); $this->decodeRow($row);
            requireValue((int)$row['revision']===$revision, 'O rascunho mudou. Revise novamente.',409);
            $review=$this->db->query('SELECT * FROM sn_reviews WHERE draft_id=? AND draft_revision=?',[$id,$revision])[0]??null;
            requireValue($review!==null && hash_equals($review['digest'],$row['digest']), 'Esta versão precisa de revisão antes de publicar.',409);
            if ($head['release_id']!==null) {
                $active=$this->release((int)$head['release_id']);
                if (hash_equals($active['digest'],$row['digest'])) { return $this->publicDocument(); }
            }
            $this->db->execute('INSERT INTO sn_releases (review_id,payload,digest,item_count,actor,created_at) VALUES (?,?,?,?,?,?)',
                [(int)$review['id'],$row['payload'],$row['digest'],(int)$row['item_count'],$actor,$now]);
            $release=(int)$this->db->pdo->lastInsertId();
            $this->db->execute('UPDATE sn_head SET generation=generation+1,release_id=? WHERE id=1',[$release]);
            $this->db->audit('catalogue_published',$actor,$release,$now); return $this->publicDocument();
        });
    }
    private function release(int $id): array
    {
        $row=$this->db->query('SELECT * FROM sn_releases WHERE id=?',[$id])[0]??null;
        requireValue($row!==null,'Publicação não encontrada.',404); $this->decodeRow($row); return $row;
    }
    public function rollback(int $id, int $generation, string $actor, int $now): array
    {
        positive($id); positive($generation,true);
        return $this->db->transaction(function () use ($id,$generation,$actor,$now): array {
            $head=$this->db->query('SELECT * FROM sn_head WHERE id=1 FOR UPDATE')[0]??null;
            requireValue($head!==null && (int)$head['generation']===$generation,'A publicação mudou. Recarregue antes de reverter.',409);
            $this->release($id);
            if ((int)$head['release_id']!==$id) {
                $this->db->execute('UPDATE sn_head SET generation=generation+1,release_id=? WHERE id=1',[$id]);
                $this->db->audit('catalogue_rolled_back',$actor,$id,$now);
            }
            return $this->publicDocument();
        });
    }
    public function publicDocument(): array
    {
        $row=$this->db->query('SELECT h.generation, r.* FROM sn_head h JOIN sn_releases r ON r.id=h.release_id WHERE h.id=1')[0]??null;
        requireValue($row!==null,'Nenhum catálogo publicado.',404); $this->decodeRow($row);
        return ['format'=>'sintonema.catalogue-publication','version'=>1,'generation'=>(int)$row['generation'],
            'releaseId'=>(int)$row['id'],'sha256'=>$row['digest'],'content'=>$row['payload']];
    }
    public function dashboard(): array
    {
        $head=$this->db->query('SELECT generation,release_id FROM sn_head WHERE id=1')[0]??null;
        requireValue($head!==null,'Publicação não confirmada.',503);
        return ['head'=>['generation'=>(int)$head['generation'],'releaseId'=>$head['release_id']===null?null:(int)$head['release_id']],
            'drafts'=>$this->db->query('SELECT d.id,d.revision,d.title,d.digest,d.item_count,d.updated_at,r.id AS review_id FROM sn_drafts d LEFT JOIN sn_reviews r ON r.draft_id=d.id AND r.draft_revision=d.revision AND r.digest=d.digest ORDER BY d.id DESC LIMIT 100'),
            'releases'=>$this->db->query('SELECT id,digest,item_count,actor,created_at FROM sn_releases ORDER BY id DESC LIMIT 100'),
            'audit'=>$this->db->query('SELECT event_type,actor,reference_id,created_at FROM sn_audit ORDER BY id DESC LIMIT 50')];
    }
}
