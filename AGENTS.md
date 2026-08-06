# Regras para agentes de desenvolvimento

1. Este é o repositório canônico. Não crie implementação paralela.
2. Preserve `tenantId` em todo recurso operacional.
3. Não associe canal diretamente a uma única unidade; conexões podem ser corporativas.
4. Hermes nunca acessa SQL, segredos de canal ou memória global de pacientes.
5. Agendamento começa em modo manual: coletar, confirmar e transferir.
6. Problema, baixa confiança ou pedido humano sempre geram handoff.
7. Takeover humano bloqueia a automação antes da resposta humana.
8. LLM não calcula preços nem decide equivalência clínica.
9. Integrações externas usam capacidades, idempotência e reconciliação.
10. Não faça deploy ou conecte contas reais sem autorização explícita.

