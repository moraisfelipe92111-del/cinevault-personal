# Sintonema — primeiro acesso e painel mínimo

Data: 25/10/2026. Base: `ea3a5ac75a7bc31caf955bc9f2dead890d3d84b8`.

Status em 25/10/2026: primeiro acesso sem cadastro, restauração e preferências opcionais implementados localmente na entrega public-access, ainda aguardando aplicação e CI. Painel, conta, identificador de consumidor, backend e sincronização permanecem pendentes. A seção de persistência registra o contrato concreto desta entrega.

## Recorte inicial

O aplicativo público permite descobrir obras, organizar uma biblioteca e acompanhar episódios sem cadastro. A administração é um painel web privado para operar o catálogo. Uma conta opcional para sincronização/recuperação será uma entrega própria; o estado local existente não representa uma conta remota.

| Componente | Primeira entrega proposta | Entrega posterior |
| --- | --- | --- |
| Aplicativo | Uma biblioteca local; descoberta, acompanhamento e cópia externa; entrada sem cadastro | Conta opcional, sincronização e múltiplos perfis, se adotados |
| Painel | Um proprietário autenticado; catálogo, fontes, revisão, publicação e operação | Colaboradores com permissões próprias e módulos comerciais aprovados |
| Serviço central | Catálogo/configuração publicados e administração protegida | Dados pessoais sincronizados somente mediante adesão e autenticação |

## Decisões de acesso e identidade

- AC-D01: uso pessoal local sem cadastro obrigatório; não pedir nome, e-mail, telefone, CPF, contatos ou localização para explorar e acompanhar.
- AC-D02: uma biblioteca local por instalação no primeiro recorte. Não introduzir UUID de consumidor só para contar instalações: não existe caso de uso operacional que exija isso nesta entrega. A referência de autoridade SQLite não será reaproveitada como identidade de pessoa.
- AC-D03: se surgir finalidade concreta para identificar perfis, especificar uma referência aleatória privada e seu ciclo de vida antes de alterar persistência/backup. Não usar identificadores de hardware ou publicidade como identidade da biblioteca.
- AC-D04: ID, conta, sessão e obra do catálogo têm finalidades distintas. Um ID não é senha, credencial de API ou prova de titularidade.
- AC-D05: atualização preserva os dados; reinstalação/troca de aparelho não promete recuperação automática. Uma cópia restaurável pode transferir o estado. Sem cópia ou serviço remoto implementado, não há recuperação garantida apenas por um ID.
- AC-D06: conta remota, se implementada, será opcional e destinada a benefícios reais. Exige autenticação, recuperação, saída, revogação/exclusão, isolamento entre pessoas e resolução de conflitos. Não criar uma conta remota oculta ao iniciar o aplicativo.
- AC-D07: biblioteca pessoal não é enviada automaticamente ao painel. Contar instalações, sessões e pessoas como se fossem a mesma métrica fica proibido na especificação.

## Jornada proposta do aplicativo

| Estado/tela | Conteúdo e ações | Resultado esperado |
| --- | --- | --- |
| Abertura | Validar/abrir o estado local pelo bootstrap; separar instalação nova legítima de falha em banco confirmado | Em falha, recuperar explicitamente; nunca abrir uma biblioteca vazia como substituição silenciosa |
| Boas-vindas, só no primeiro uso | Explicar descoberta e acompanhamento; informar que a reprodução completa ocorre nos serviços oficiais; ações Explorar agora e Restaurar cópia | Explorar sem cadastro ou permissão desnecessária; restaurar somente após validação |
| Preferências opcionais | Gostos iniciais e contexto, com Agora não e edição posterior | Pular mantém a experiência utilizável; gostos do casal original não viram preferências da nova pessoa |
| Biblioteca | Filmes e séries/programas, busca, filtros e acompanhamento | Estado pessoal começa sem favoritos/histórico de testadores; curadoria inicial é identificada como tal |
| Seus dados | Explicar dados locais, exportação, restauração, troca de aparelho e controles de redefinição | Não chamar compartilhamento manual para o Drive de sincronização automática |
| Atualização de instalação existente | Preservar dados e preferências; eventual aviso de novidade dispensável | Não reexecutar onboarding como condição para acessar a biblioteca |

Permissões devem surgir no contexto da função correspondente. A região inicial de disponibilidade pode ser BR, ajustável manualmente; não pressupõe geolocalização. Usar sem cadastro não elimina o inventário de imagens, trailers, consultas e registros técnicos de terceiros.

### Persistência da jornada

O primeiro acesso e os formatos de exploração usam o campo opcional `publicAccess: {version: 1, completed: true, formats: [...]}` dentro de `cinevault.experience.v1`. O campo só é gravado por uma ação explícita e pela fila de confirmação existente. Nenhuma chave ou tabela nova é criada para a jornada; a cópia completa já inclui o valor bruto. O indicador de animação não é usado como conclusão do primeiro acesso. Preferências antigas continuam sem esse campo; conteúdo desconhecido ou de versão futura não pode ser reduzido e sobrescrito. Um snapshot restaurado inteiramente ausente não recebe marcação adicional: abre a biblioteca nessa sessão e pode oferecer boas-vindas na próxima abertura. Os 1.000 IDs locais e a origem congelada permanecem intactos. Os formatos escolhem atalhos de exploração, não fingem compor um modelo pessoal de recomendação.

O controle de redefinição será uma ação explícita, com confirmação e oferta de cópia. Não será chamado automaticamente quando o banco, a autoridade ou a leitura falhar. Deverá abranger de forma coerente os dados/recibos locais correspondentes e explicar que arquivos exportados fora do app não são apagados por esse controle.

## Painel mínimo — telas e ações

Primeiro operador: Felipe como proprietário. A entrada administrativa é independente do acesso sem cadastro das pessoas que usam o aplicativo. O segundo fator e a recuperação administrativa são requisitos de implementação. Um único proprietário pode revisar e publicar no primeiro recorte, com etapas distintas e histórico; não pressupor um segundo funcionário.

| Tela proposta | Ações do proprietário | Restrição relevante |
| --- | --- | --- |
| Entrar e recuperar acesso | Autenticar, confirmar segundo fator, recuperar e revogar sessões | Sem autorização, nenhuma operação protegida é executada pelo servidor |
| Catálogo | Buscar obra por identidade, revisar metadados, categorias e situação | Não renumerar os filmes 1–1000; não fabricar notas pessoais, aliases ou dados ausentes |
| Importações | Registrar fornecedor/lote; visualizar candidatos, colisões, remakes e erros | Importar não publica automaticamente; origem e direito de uso ficam registrados |
| Ficha de revisão | Conferir fonte, identidade, créditos, idioma, imagem e licença | Dados não revisados permanecem candidatos; nenhuma conversão numérica presumida entre fontes |
| Publicações | Validar, visualizar prévia, publicar versão e voltar a uma versão válida | Uma alteração administrativa não apaga bibliotecas pessoais; versões publicadas têm registro imutável |
| Fontes e operação | Ver falhas de importação, links, cotas, atualizações e avisos relevantes | Segredos privados não entram no app, respostas públicas ou logs |

Não haverá uma tela fictícia de usuários com nomes/favoritos que nunca foram enviados. O módulo de contas de consumidores só será implementado se existir conta/sincronização correspondente. Métricas iniciais podem usar dados agregados das lojas e saúde do próprio serviço; rastreamento de comportamento precisa de decisão e inventário próprios.

### Fluxo de publicação

1. Importar ou editar rascunho com fonte e identidade verificáveis.
2. Validar schema, colisões, direitos/créditos e compatibilidade com clientes suportados.
3. Revisar a diferença e a prévia; o proprietário confirma a publicação.
4. Publicar uma versão identificável; registrar autor, momento, resultado e referência da versão anterior.
5. Em falha, manter a versão válida; reversão seleciona uma publicação anterior válida e não altera dados pessoais locais.

O mecanismo de publicação aceita dados/configuração validados, não código executável remoto. Links de oferta, região e afiliação só entram quando a fonte e a parceria correspondentes estiverem aprovadas; clique não constitui conversão nem receita confirmada.

## Limites dos dados e serviços

| Dados | Local proposto | Acesso proposto |
| --- | --- | --- |
| Catálogo e créditos revisados | Bundle inicial e catálogo central publicado | Leitura pública, respeitando licença; escrita só administrativa |
| Favoritos, histórico, notas e progresso | SQLite no aparelho e cópias exportadas por ação da pessoa | Biblioteca local; sem envio automático ao painel |
| Preferências de experiência atuais | Armazenamento pessoal existente | Preservadas na atualização e na cópia completa |
| Credenciais e permissões administrativas | Serviço de identidade/servidor a escolher | Administração autenticada; segredos privados fora do cliente |
| Sessões/contas de consumidores | Ausentes no primeiro recorte | Criar somente quando o módulo opcional for implementado |
| Diagnóstico e eventos | Mínimo necessário, finalidade e retenção a definir | Não incluir valores privados do backup ou notas nos logs |

Contratos a detalhar na implementação: versão/schema do catálogo; identidade por fonte/tipo; origem e atualização; integridade do conteúdo; URLs permitidas; versão mínima do cliente; tratamento de falhas e limites de tamanho. O cliente mantém uma base utilizável e a última versão válida se o servidor falhar. Remover uma obra da publicação não autoriza descartar silenciosamente progresso preservado sem correspondência.

O painel precisa de autorização no servidor, isolamento de ambientes, proteção de sessões e proteção contra requisições indevidas conforme o mecanismo escolhido. Backend, armazenamento central, domínio/hospedagem, orçamento, contratos concretos de API e solução de autenticação ainda precisam ser escolhidos; esta especificação não contrata nem provisiona serviços.

## Critérios de aceite para as entregas futuras

Os critérios continuam sendo a referência do produto completo. AC-01/02/03/05/07 têm implementação e testes locais nos fluxos descritos em public-access.json; isso não certifica o futuro APK, a implantação administrativa ou todos os casos físicos. AC-04/06 mantêm as evidências anteriores no alcance registrado; AC-08 e todos os critérios administrativos/operacionais ainda exigem implementação ou validação própria.

| ID | Cenário | Resultado obrigatório |
| --- | --- | --- |
| AC-01 | Instalação nova sem cadastro | Explorar e iniciar biblioteca sem dados cadastrais, favoritos ou histórico de testadores |
| AC-02 | Atualizar uma instalação com dados | Preservar IDs, dados e preferências; nenhum onboarding bloqueia o acesso |
| AC-03 | Pular preferências iniciais | Experiência funcional; recomendações não fingem conhecer o gosto da pessoa |
| AC-04 | Abrir e registrar progresso sem rede | Dados locais utilizáveis e gravação durável após reabrir; ausência de imagem tratada com fallback |
| AC-05 | Restaurar cópia completa válida | Aplicação atômica e preservação dos registros suportados, inclusive não mapeados |
| AC-06 | Banco confirmado ausente/corrompido | Recuperação explícita; nenhuma biblioteca vazia substitui o estado anterior |
| AC-07 | Trocar aparelho sem cópia/conta | Não prometer recuperação automática por um ID; explicar o caminho disponível |
| AC-08 | Redefinir dados locais | Exigir ação e confirmação explícitas; cancelamento preserva tudo; tratar recibos coerentemente |
| AD-01 | Operação administrativa sem sessão válida | Negar no servidor sem ler ou alterar o recurso protegido |
| AD-02 | Importar um candidato ambíguo | Manter em revisão sem publicação nem alias inventado |
| AD-03 | Publicar catálogo inválido | Recusar e manter a versão publicada anteriormente |
| AD-04 | Publicar lote revisado | Versão e alterações auditáveis; IDs estáveis e nenhum segredo privado no conteúdo |
| AD-05 | Reverter publicação | Restabelecer uma versão válida sem apagar o estado pessoal de clientes |
| AD-06 | Expor erro/diagnóstico | Informar falha sem notas, valores de backup ou credenciais em logs/respostas |
| OP-01 | Serviço ou fornecedor fora do ar | Usar base/última cópia válida; não bloquear a biblioteca pessoal |
| OP-02 | Restaurar cópia do servidor em homologação | Recuperar publicação e administração pelo procedimento documentado |
| OP-03 | Tentar consultar visitante pelo painel | Não disponibilizar dados pessoais que permanecem exclusivamente locais |

## Ordem de implementação

1. Revisar este contrato de produto junto do plano mestre e preservar a base nativa aprovada.
2. Teste básico do build18 confirmado por relato: atualização, dados preservados e T1/E1 após reabrir. Felipe adiou a nova cópia/restauração manual para avançar; o caso segue pendente e não bloqueia esta implementação. O APK instalado ainda não contém a jornada nova.
3. Escolher contratos/infraestrutura e implementar autenticação administrativa e publicação mínima do catálogo com validação/reversão.
4. Aplicar e aprovar a jornada pública preparada; reunir recomendações, marca e demais melhorias em candidatos completos. Concluir os testes de lançamento, direitos e distribuição nos marcos correspondentes.
5. Desenvolver conta/sincronização e módulos comerciais em entregas próprias quando os benefícios, custos e condições estiverem definidos.
