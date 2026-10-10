import { setAuthSettings, setOidcSettings } from '../../packages/auth/src/instance';
import { auth } from '../../packages/auth/src/index';
import { syncKeycloakAccess } from '../../apps/api/src/modules/organization/keycloak';
import { db } from '../../packages/db/src/index';
const secrets = await Bun.file('.local/v1/secrets.json').json();
const accounts = await Bun.file('.local/v1/accounts.json').json();
const bootstrap = await db.query.user.findFirst({
  where: (user, { eq }) => eq(user.email, 'bootstrap@frnd.app'),
});
if (!bootstrap)
  await auth.api.signUpEmail({
    body: { name: 'Local bootstrap', email: 'bootstrap@frnd.app', password: accounts.admin },
  });
await setOidcSettings({
  enabled: true,
  label: 'Sign in with Local Keycloak',
  discoveryUrl: 'http://localhost:18080/realms/itsaplan-local/.well-known/openid-configuration',
  clientId: 'itsaplan-web',
  clientSecret: secrets.client,
  scopes: ['openid', 'profile', 'email'],
  pkce: true,
});
await setAuthSettings({ registration: 'closed', emailPassword: false });
await syncKeycloakAccess();
console.log('Local OIDC configured; company accounts synchronized.');
process.exit(0);
