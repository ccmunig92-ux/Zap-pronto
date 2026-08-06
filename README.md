# Zap Pronto

Plataforma SaaS omnichannel, multiempresa, multiunidade e multiusuário para atendimento humano e assistido por agentes.

## Invariantes

- A plataforma possui banco e ciclo de vida próprios.
- Uma conexão de WhatsApp, Instagram ou Facebook pode atender várias unidades.
- Vários atendentes compartilham a inbox; somente um humano responde por conversa por vez.
- Hermes é runtime conversacional, não banco, CRM, agenda ou motor de preço.
- Sem integração de agenda homologada, o agente coleta, confirma e transfere para humano.
- Coleta concluída, problema ou pedido por humano sempre resultam em handoff.
- Takeover humano suspende a automação.
- Preço exige unidade e versão de tabela.
- Integrações externas são opcionais e passam por contratos idempotentes.

## Estado atual

Fundação de contratos e regras de domínio. Não há integração ou deploy de produção.

