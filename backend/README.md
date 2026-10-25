# Sintonema — painel administrativo e backend

Implementação inicial para PHP 8.3+ atualizado, PDO MySQL, Sodium e Argon2id, com MySQL 8 ou MariaDB/InnoDB. Destina-se à hospedagem já utilizada pelo proprietário, com **subdomínio e banco exclusivos**. O plano, a versão real do PHP, extensões, SSH, quotas, certificado e diretórios ainda precisam ser conferidos antes da implantação. Nenhum servidor foi provisionado e nenhuma credencial real está neste repositório.

## O que esta entrega faz

- Login do proprietário com senha e TOTP; também aceita um código de recuperação de uso único junto da senha.
- Sessão com prazo total de oito horas, inatividade de vinte minutos, rotação ao autenticar e revogação global.
- Bloqueio de tentativas por endereço com HMAC e limite global; identificadores de tentativa expiram após quinze minutos.
- Catálogo: lotes, importação JSON, busca, ficha de título e editor avançado. Importar cria rascunho, sem publicação automática.
- Revisão de identidade/direitos vinculada à revisão e ao SHA-256 do conteúdo. Editar invalida a revisão anterior.
- Publicação e reversão transacionais. Gerações crescem; publicações anteriores permanecem preservadas. Um erro não publica um catálogo vazio.
- Endpoint público com bytes canônicos, digest e ETag. Nenhuma biblioteca, favorito, nota, consumidor ou histórico do aplicativo é recebido.

O APK instalado **não consulta esse serviço ainda**. Publicar no painel disponibiliza a resposta pública do servidor; a futura integração do aplicativo será uma entrega própria, com compatibilidade, validação e fallback para o catálogo local. O nome do painel não altera o package ID ou a marca ainda exibida no APK.

## Isolamento e disposição dos arquivos

```text
pasta-privada-sintonema/
  bootstrap.php
  config.php                 # arquivo real privado, permissão 600, nunca versionado
  schema.sql
  src/
  resources/
  bin/
  sessions/                  # diretório privado, permissão 700

raiz-publica-do-subdominio/
  index.php
  api.php
  admin.mjs
  admin.css
```

Somente os quatro arquivos de `backend/public` pertencem à raiz pública do subdomínio do painel. Os demais ficam fora de **todos** os diretórios públicos, inclusive `public_html` do projeto existente. O backend recusa configuração dentro da raiz pública ou de um diretório `public_html`/`htdocs`. Não copiar credenciais, sessões ou o banco do Tô Disponível.

`api.php` usa `SINTONEMA_PRIVATE_DIR` quando definido na configuração do servidor. Sem essa variável, procura `sintonema-private` dois diretórios acima de sua própria pasta. A disposição real precisa ser conferida: se a pasta pública for `/home/CONTA/domains/DOMINIO/public_html`, o padrão será `/home/CONTA/domains/sintonema-private`. Nunca adivinhar o caminho da conta. No hPanel, ajustar a configuração do servidor ou a disposição privada antes de ativar o endpoint.

Produção exige a raiz de um subdomínio HTTPS exclusivo, por exemplo `https://painel.DOMINIO`, cookie `__Host-SINTONEMA_ADMIN` com Secure/HttpOnly/SameSite=Strict e origem exata nas gravações. Apenas os testes podem usar HTTP em `127.0.0.1`; cabeçalhos de proxy não transformam uma conexão comum em HTTPS. O painel não compartilha sessão com outro aplicativo.

## Configuração privada e primeiro proprietário

1. Criar no hPanel um banco dedicado com `sintonema` no nome e usuário exclusivo. Nunca usar o banco do outro aplicativo.
2. Copiar `config.example.php` para `config.php` na pasta privada. Definir URL HTTPS do painel, DSN, banco, usuário e senha reais somente nesse arquivo; permissão `600`.
3. Gerar uma chave pela linha de comando privada: `php bin/admin.php key`. Guardá-la na configuração e em um cofre/backup privado.
4. Criar `sessions` com permissão `700`. Conferir PHP atualizado, extensões, certificado, host e acesso SSH. Não mudar a versão global de PHP do outro projeto para realizar esta entrega.
5. Executar `SINTONEMA_PUBLIC_DIR=/CAMINHO/DA/RAIZ/PUBLICA php bin/admin.php migrate` na pasta privada. A instalação inicial exige um banco vazio. DDL MySQL não é atômico: uma instalação interrompida é recusada na abertura; requer análise explícita, sem reparação ou limpeza automática.
6. Executar `SINTONEMA_PUBLIC_DIR=/CAMINHO/DA/RAIZ/PUBLICA php bin/admin.php owner` fornecendo um objeto JSON com `username` e `password` pelo stdin privado. A senha precisa de ao menos 14 caracteres. Não usar senha em URL ou argumento de comando, não salvar o conteúdo em arquivo público nem colar no chat.
7. A saída privada traz a URI/segredo do autenticador e dez códigos de recuperação. Cadastrar no autenticador e guardar os códigos em local seguro. Entrar com senha e segundo fator; nenhuma rota web cria o proprietário.

Se a pasta privada implantada não contiver `public/`, `SINTONEMA_PUBLIC_DIR` é necessário para os comandos que abrem a configuração. `key` funciona sem configuração. `check` informa apenas versão do schema, PHP e se existe proprietário configurado.

Recuperação por um código: informar a senha e um dos códigos no formulário de login; ele será consumido na mesma transação. Recuperação completa por acesso privado à hospedagem: `recover-owner`, com `username`, nova `password` e `confirm` igual a `RECONFIGURAR PROPRIETARIO` no stdin. Isso substitui os fatores e encerra sessões existentes. Trocar a chave privada exige reconfigurar o proprietário; uma chave perdida não autoriza abrir o painel sem autenticação.

## Contrato do catálogo

Para iniciar com o acervo já existente, `node scripts/prepare-admin-catalogue.mjs /CAMINHO/ABSOLUTO/candidatos.json` prepara os 1.000 filmes e oito programas em um arquivo novo. O comando recusa sobrescrita, não acessa dados pessoais e não publica nada. Importar esse arquivo no painel cria um rascunho; licenças, imagens e conteúdo ainda precisam de revisão antes de publicar. O arquivo é uma preparação editorial, não uma cópia da biblioteca pessoal.

Um lote contém `format: sintonema.catalogue`, `version: 1`, `mode: supplement` e `items` de 1 a 10.000 títulos, até 4 MiB. Campos exatos de cada título:

| Campo | Contrato |
| --- | --- |
| `key` | `local:movie:ID`, `tmdb:movie:ID`, `tmdb:tv:ID` ou `tvmaze:tv:ID`, sem coerção/aliases presumidos |
| `title` / `year` | Título em texto simples; ano inteiro verificável ou `null` |
| `kind` | `movie`, `series`, `short` ou `special`, coerente com a identidade |
| `categories` | Lista única: fiction/anime/reality/documentary/animation/soap/children/other |
| `posterUrl` | Imagem canônica TMDb/TVmaze suportada, ou `null`; sem query/redirect/link arbitrário |
| `sourceUrl` | Página oficial correspondente ao mesmo ID; `null` para o registro local |
| `attribution` | Crédito da origem em texto simples |

O registro privado de compatibilidade `resources/legacy-films.json` conserva título/ano dos 1.000 IDs e os 983 aliases TMDb já revisados. O painel não pode trocar a identidade desses filmes nem importar um alias conhecido como se fosse outra obra; deve usar a identidade local preservada. As 17 identidades sem vínculo revisado não recebem aliases presumidos. Registros de fontes externas usam namespaces; números iguais de fontes/tipos diferentes não são a mesma obra. Novas fontes e campos exigem evolução explícita do contrato. Não existem rotas de notas pessoais ou dados de consumidores.

`supplement` significa uma publicação complementar. Ausência de um filme nesse documento não autoriza apagar o catálogo empacotado, favoritos ou progresso local. A integração cliente ainda precisará implementar esse contrato antes de consumir o endpoint.

A revisão confirma três itens: identidade, direitos/créditos dos metadados e direitos das imagens utilizadas ou sua remoção. Trata-se de registro do trabalho do proprietário; o painel não valida um contrato comercial automaticamente nem concede licenças de terceiros. A revisão/licença comercial geral do projeto continua pendente. Nenhum título do catálogo atual é publicado automaticamente.

## API

Todas as respostas são JSON. Recursos protegidos exigem sessão válida. POST exige JSON, Origin exata e token de sessão `X-CSRF-Token`. Não há CORS liberado para a administração.

| Método/recurso (`api.php?r=...`) | Operação |
| --- | --- |
| GET `session` / POST `login` | Token anti-CSRF; login com senha e TOTP/código de recuperação |
| GET `dashboard` / GET `draft&id=N` | Resumo privado e rascunho |
| POST `drafts/create`, `drafts/update` | Criar/editar; atualização exige revisão esperada |
| POST `drafts/review` | Vincular revisão ao digest e versão esperados |
| POST `publish` / `rollback` | Publicar/reverter com geração esperada; conflito retorna 409 |
| POST `logout` / `sessions/revoke` | Encerrar sessão atual/todas as sessões |
| GET `catalogue` | Última publicação verificada; 404 antes da primeira; falha preserva os dados |

Resposta pública: `format: sintonema.catalogue-publication`, versão 1, geração, ID da publicação, `sha256` e `content`. O hash é calculado sobre os bytes UTF-8 da string `content`, que contém o documento canônico validado. Preservar essa string ao verificar em outra linguagem; não recalcular o hash de uma serialização diferente. Um SHA-256 detecta alterações acidentais; não substitui HTTPS ou autenticação do servidor. ETag inclui geração/digest. Reversão aumenta a geração e seleciona uma publicação anterior válida.

## Verificação e marcos restantes

`php backend/tests/run.php` e `node --test backend/tests/http.test.mjs` exigem as variáveis `SINTONEMA_TEST_DSN`, `SINTONEMA_TEST_DATABASE`, `SINTONEMA_TEST_DB_USER` e `SINTONEMA_TEST_DB_PASSWORD` de um banco sintético `sintonema_test_*`. Esses testes removem tabelas **somente** desse banco descartável; não fornecer credenciais de produção. O teste HTTP cria configuração privada temporária e encerra seu próprio servidor PHP. O workflow usa credenciais sintéticas sem relação com a hospedagem real.

Nesta entrega, o código e os testes estão preparados para o repositório. Implantação, configuração inicial real, MFA do proprietário, backup/restauração do banco administrativo, disponibilidade, quotas, rotação de chave, sessão HTTPS no domínio final e integração cliente ainda precisam de validação nos ambientes correspondentes. Não há liberação de produção automática após o CI.

Referências primárias consultadas em 25/10/2026: [Hostinger/banco dedicado](https://www.hostinger.com/support/1583542-how-to-create-a-new-mysql-database-in-hostinger/), [importação MySQL sem privilégios especiais](https://www.hostinger.com/support/1864324-how-to-upload-and-set-up-your-database-at-hostinger/), [PHP suportado](https://www.php.net/supported-versions.php), [password_hash](https://www.php.net/manual/en/function.password-hash.php), [sessões PHP](https://www.php.net/manual/en/session.security.ini.php), [OWASP/CSRF](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html), [RFC 6238](https://www.rfc-editor.org/rfc/rfc6238.html).
