import { randomBytes } from 'node:crypto';
import { chmod, mkdir } from 'node:fs/promises';

const directory = '.local/v1';
const targets = [
  '.env',
  '.env.test',
  'apps/web/.env',
  `${directory}/secrets.json`,
  `${directory}/accounts.json`,
];
for (const path of targets)
  if (await Bun.file(path).exists())
    throw new Error(`Refusing to overwrite ${path}. Use the existing local configuration.`);
await mkdir(directory, { recursive: true, mode: 0o700 });
const random = () => randomBytes(32).toString('base64url');
const secrets = Object.fromEntries(
  ['postgres', 'keycloak', 'client', 'provisioner', 'auth', 'encryption'].map((key) => [
    key,
    random(),
  ]),
);
const accounts = Object.fromEntries(
  ['admin', 'member', 'newmember', 'denied', 'external'].map((key) => [key, random()]),
);
async function write(path: string, content: string) {
  await Bun.write(path, content);
  await chmod(path, 0o600);
}
await write(`${directory}/secrets.json`, JSON.stringify(secrets));
await write(`${directory}/accounts.json`, JSON.stringify(accounts));
const replacements = { ...secrets, ...accounts };
const realm = (await Bun.file('scripts/local-v1/realm.template.json').text()).replace(
  /\$\{(\w+)\}/g,
  (_, name: string) => replacements[name]!,
);
await write(`${directory}/realm.json`, realm);
await write(
  `${directory}/compose.env`,
  `POSTGRES_PASSWORD=${secrets.postgres}\nKC_BOOTSTRAP_ADMIN_PASSWORD=${secrets.keycloak}\n`,
);
const env = `POSTGRES_USER=itsaplan
POSTGRES_PASSWORD=${secrets.postgres}
POSTGRES_DB=itsaplan_v1
POSTGRES_PORT=55432
DATABASE_URL=postgres://itsaplan:${secrets.postgres}@localhost:55432/itsaplan_v1
API_URL=http://localhost:13000
APP_URL=http://localhost:3001
API_PORT=13000
BETTER_AUTH_SECRET=${secrets.auth}
APP_ENCRYPTION_KEY=${secrets.encryption}
ITSAPLAN_MANAGED_ACCESS=true
ITSAPLAN_KEYCLOAK_ISSUER=http://localhost:18080/realms/itsaplan-local
ITSAPLAN_KEYCLOAK_CLIENT_ID=itsaplan-provisioner
ITSAPLAN_KEYCLOAK_CLIENT_SECRET=${secrets.provisioner}
`;
await write('.env', env);
await write(
  '.env.test',
  env
    .replaceAll('/itsaplan_v1', '/itsaplan_v1_test')
    .replace('ITSAPLAN_MANAGED_ACCESS=true', 'ITSAPLAN_MANAGED_ACCESS=false')
    .replace('API_URL=http://localhost:13000', 'API_URL=http://localhost:3000')
    .replace('API_PORT=13000', 'API_PORT=3000') + 'NODE_ENV=test\n',
);
await write('apps/web/.env', 'API_URL=http://localhost:13000\n');
console.log('Local configuration created. Test account passwords are in .local/v1/accounts.json.');
