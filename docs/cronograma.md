# Cronograma canônico de desenvolvimento

Este cronograma é orientado por gates. Datas não autorizam avançar com critérios de aceite pendentes.

## Status de execução — 06/08/2026

- Fase 0: concluída, publicada e validada no CI remoto.
- Fase 1: concluída, integrada ao `main` e validada no CI remoto (PR #1).
- Fase atual: **Fase 2 — domínio operacional e persistência**.
- PostgreSQL real: aprovado localmente em PostgreSQL 18.3.
- Migration do zero: aprovada.
- RLS com dois tenants: SELECT, INSERT, UPDATE e DELETE testados.
- Atribuição de atendente fora da unidade: bloqueada em teste real.
- Controle de migrations por checksum e advisory lock: aprovado localmente.
- CI com PostgreSQL 18, typecheck e testes: aprovado no `main`.
- Primeiro commit canônico local: criado e validado.
- Contexto transacional parametrizado e testes de pool: concluídos.
- Membership ator/tenant validado no banco: implementado localmente.
- Matriz RLS das 19 tabelas: SELECT/INSERT/UPDATE/DELETE cruzados testados localmente.
- Membership ator/tenant e matriz CRUD RLS: concluídos.
- Papéis separados de API e worker: concluídos e reauditos.
- Fase 2A em execução no branch `codex/phase-2-operational-domain`:
  lifecycle tipado, histórico tenant-aware e outbox com lease/dead-letter modelados;
  solicitação de handoff atômica e claim otimista implementados.
- Prova local da Fase 2A: migration do zero, RLS e dois claims concorrentes com exatamente um vencedor.
- Pendências do gate da Fase 2: transições completas, worker de outbox, orçamento reproduzível,
  pedido médico/OCR revisável e suíte integral de concorrência/rollback.
- Fases 3–9: não iniciadas.

## Premissas

- Um único monólito modular no MVP; sem microserviços prematuros.
- PostgreSQL próprio é a fonte de verdade.
- Escopo de tenant e unidade nunca é aceito diretamente do corpo da requisição.
- Hermes não acessa SQL, não confirma agenda e para imediatamente no takeover humano.
- Integrações Meta e sistemas externos entram pelo mesmo envelope canônico.
- ProntoMedic é o primeiro tenant e uma integração opcional, não o núcleo da plataforma.

## Visão geral

| Fase | Prazo alvo | Resultado obrigatório | Gate de saída |
|---|---:|---|---|
| 0. Baseline | 2 dias | PostgreSQL real, CI e baseline Git | Migration executa do zero e testes passam |
| 1. Dados e segurança | 5 dias | RLS, integridade, estados, idempotência e LGPD mínima | Dois tenants isolados em testes reais |
| 2. Persistência e domínio | 5 dias | Repositórios transacionais, orçamento, pedido médico e outbox | Concorrência e transições inválidas bloqueadas |
| 3. API, autenticação e RBAC | 5 dias | API modular, login, convites e permissões por unidade | Matriz RBAC e testes IDOR aprovados |
| 4. Inbox e operação humana | 7 dias | Filas, claim, takeover, SLA e transferência | Um único responsável e zero resposta Hermes após takeover |
| 5. Gateway e mídia | 5 dias | Envelope, webhooks, worker e storage privado | Replay não duplica e mídia permanece privada |
| 6. Hermes, áudio e documentos | 7 dias | Coleta assistida, transcrição e extração revisável | Baixa confiança sempre gera handoff |
| 7. Canais Meta | 10 dias | WhatsApp e depois Instagram/Messenger | E2E real por canal em sandbox oficial |
| 8. Integrações externas | 7 dias/conector | Hub de capacidades e primeiro adaptador | Plataforma funciona mesmo sem o sistema externo |
| 9. Hardening e staging | 5 dias | Observabilidade, backup, carga, segurança e rollback | Restore e rollback comprovados |

Estimativa do MVP com WhatsApp: 8 semanas. Três canais Meta, App Review e homologação completa: 10 a 12 semanas. A estimativa pressupõe uma equipe pequena dedicada e acesso tempestivo às contas de sandbox.

## Fase 0 — baseline executável

Entregas:

- subir PostgreSQL local descartável;
- executar migration do zero;
- adicionar controle de migrations;
- criar CI com typecheck, testes e banco real;
- criar configuração local sem segredos;
- revisar e criar o primeiro commit canônico.

Critérios de aceite:

- banco vazio sobe de forma reproduzível;
- migration executa sem correção manual;
- nenhum segredo está versionado;
- testes atuais e testes SQL passam no CI.

## Fase 1 — isolamento e integridade

Entregas:

- RLS com `ENABLE` e `FORCE ROW LEVEL SECURITY`;
- tenant transacional via `SET LOCAL app.tenant_id`;
- papel da aplicação sem `BYPASSRLS`;
- coerência entre handoff, caso, conversa e unidade;
- atribuição restrita a atendentes autorizados na unidade;
- regras de escopo do canal e unidade;
- estados tipados e transições válidas;
- identidade externa por canal;
- idempotência inbound e outbound;
- política mínima de retenção, consentimento e auditoria append-only.

Critérios de aceite:

- tenant A não lê, insere, altera ou exclui dados do tenant B;
- handoff incompatível com caso/conversa/unidade falha;
- atendente de outra unidade não assume conversa;
- webhook concorrente e repetido produz um único efeito;
- canal só roteia para unidade autorizada.

## Fase 2 — domínio operacional e persistência

Entregas:

- repositórios transacionais;
- lifecycle de conversa, caso e handoff;
- suspensão do Hermes e criação do handoff na mesma transação;
- orçamento, itens, versão da tabela, validade, revisão, envio e aceite;
- pedido médico, páginas, itens extraídos, confiança e revisão humana;
- metadados de áudio e OCR;
- outbox com lease, backoff, tentativas e dead-letter;
- controle de concorrência otimista.

Critérios de aceite:

- somente um atendente vence o claim concorrente;
- orçamento é reproduzível centavo a centavo;
- baixa confiança ou documento ilegível cria handoff;
- falha assíncrona entra em retry e depois dead-letter;
- transições inválidas são rejeitadas no domínio e no banco.

## Fase 3 — API, autenticação e RBAC

Entregas:

- API modular única com OpenAPI e validação de entrada;
- autenticação OIDC substituível;
- convites, ativação, bloqueio e revogação;
- permissões granulares por tenant e unidade;
- rate limit, correlation ID e auditoria;
- proteção contra IDOR.

Papéis iniciais: administrador do tenant, gerente de unidade, supervisor, atendente e auditor.

Critérios de aceite:

- matriz de permissões automatizada por rota;
- usuário bloqueado perde acesso;
- administrador de unidade não acessa outra filial;
- toda mutação relevante registra ator, escopo e correlation ID.

## Fase 4 — inbox multiusuário e produtividade

Entregas:

- filas por unidade, equipe e competência;
- roteamento corporativo com confirmação de unidade;
- claim atômico, transferência, devolução, reabertura e encerramento;
- inbox em tempo real e composer humano;
- SLA de espera e primeira resposta;
- turnos, presença, pausas e capacidade;
- alertas configuráveis de baixa produtividade.

O alerta só pode disparar quando há atendente em turno, demanda disponível, limiar violado por uma janela sustentada e cooldown encerrado. O sistema registra alerta, destinatário, reconhecimento, justificativa e escalonamento.

Critérios de aceite:

- uma conversa possui no máximo um responsável ativo;
- takeover suspende o Hermes antes da resposta humana;
- transferência preserva histórico e motivo;
- alerta não dispara sem demanda, fora do turno ou em pausa autorizada;
- reconexão da UI não perde eventos.

## Fases 5 a 9

- Gateway: webhook rápido, envelope canônico, worker, ordem por conversa, storage privado, antivírus e estados de entrega.
- Hermes: ferramentas estreitas para consulta, coleta e handoff; guardrails clínicos; prompts versionados e avaliações adversariais.
- Meta: WhatsApp Cloud API primeiro; Instagram e Messenger reutilizam o envelope. Assinatura, janela, templates, mídia, status, token e App Review são obrigatórios.
- Integrações: capacidades `DISABLED`, `READ_ONLY` e `HUMAN_CONFIRMED_WRITE`, sempre com timeout, circuit breaker, idempotência e reconciliação.
- Hardening: métricas, logs, traces, SLOs, backup/restore, carga, segurança, LGPD, runbooks, staging isolado e rollback.

## Sequência imediata

1. Concluir worker transacional de outbox: claim, lease, retry, backoff, ACK e dead-letter.
2. Implementar orçamento com snapshot imutável da versão de preço e cálculo em centavos.
3. Implementar pedido médico, páginas, itens extraídos e revisão humana obrigatória.
4. Ampliar provas de rollback, idempotência concorrente e upgrade de dados legados.
5. Publicar a Fase 2 em PR próprio; manter Fases 3–9 bloqueadas até o gate verde.

Não iniciar API, interface, Hermes ou Meta antes do gate completo da Fase 2.
