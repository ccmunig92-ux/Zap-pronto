# Arquitetura canônica

## Contexto

Zap Pronto é uma plataforma SaaS independente. ProntoMedic é o primeiro tenant; sistemas clínicos e comerciais são integrações opcionais.

```text
WhatsApp / Instagram / Facebook
              |
        Channel Gateway
              |
        Platform Core ---- banco próprio
          |       |
        Hermes  Inbox humana
          |
     Integration Hub ---- sistemas externos
```

## Responsabilidades

- Platform Core: tenants, unidades, usuários, contatos, conversas, documentos, preços, orçamentos, filas, produtividade e auditoria.
- Hermes: entendimento, coleta, confirmação e solicitação de ferramentas/handoff.
- Integration Hub: capacidades opcionais, idempotência, sincronização e reconciliação.
- Inbox: atribuição exclusiva, takeover e conclusão humana.

## Fluxo de agendamento inicial

```text
Agente coleta -> cliente confirma -> handoff persistido -> humano assume -> humano agenda
```

## Persistência

- PostgreSQL próprio é a fonte de verdade.
- `tenant_id` é obrigatório em todo dado operacional.
- Relações críticas usam chaves compostas com `tenant_id`.
- Uma conexão de canal pode atender várias unidades.
- Preços são versionados por unidade e armazenados em centavos.
- Mensagens, handoffs e eventos são idempotentes.
- Arquivos ficam em object storage; o banco guarda metadados e extrações.
- Integrações assíncronas usam outbox e ações relevantes geram auditoria.

