# Backup e restore do staging

O backup é lógico, data-only e não contém passwords, roles globais ou ACLs. O schema e os roles são
reconstruídos pelas migrations da mesma revisão da aplicação antes do restore. `schema_migrations` é
registrada no manifesto, mas seus dados não são duplicados no archive. `app_roles`, `app_permissions` e
`app_role_permissions` também são excluídas porque são política versionada e repopulada pelas migrations.

## Backup

Execute `scripts/staging-backup.sh` com as variáveis de `backup.env.example`. Cada execução cria um diretório
privado contendo `data.dump`, `data.dump.sha256` e `manifest.txt`. O bundle temporário só é promovido após
`pg_restore --list` e checksum passarem. A retenção roda depois da promoção bem-sucedida.

Copie os bundles para armazenamento externo criptografado e imutável. O volume Docker e o diretório local de
backup no mesmo disco não constituem recuperação de desastre.

## Restore

O restore é destrutivo para o staging selecionado e exige simultaneamente:

- `ALLOW_STAGING_RESTORE=yes`;
- `STAGING_RESTORE_CONFIRM` igual ao nome do projeto Compose;
- bundle regular, não symlink, com checksum válido;
- schema inicializado pela mesma cadeia de migrations;
- nenhuma linha operacional no destino, exceto `schema_migrations`.

Execute `scripts/staging-backup-restore.sh /caminho/do/bundle`. API e web são parados antes da verificação.
O script restaura dados com triggers temporariamente desabilitados, reprovisiona o role runtime e só então
reinicia API/web. Falha mantém os serviços de aplicação parados.

`STAGING_RESTORE_START_APPLICATION=no` existe apenas para smoke/manutenção controlada; nesse modo o operador
deve validar o banco e iniciar explicitamente os serviços depois. O padrão seguro operacional continua `yes`.

## Critérios de aceite

1. Backup nunca sobrescreve bundle existente e não deixa bundle final parcial.
2. Secrets não aparecem no archive, manifesto, argumentos do processo ou logs.
3. Checksum e catálogo do archive são verificados antes do restore.
4. Restore em banco com dados operacionais falha antes de qualquer escrita.
5. Smoke efêmero prova backup, recriação do volume, migrations, restore, role runtime, readiness e dados.
6. Retenção nunca é executada quando a criação/validação do novo bundle falha.
