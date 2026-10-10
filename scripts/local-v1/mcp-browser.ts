import { createHash, randomBytes } from 'node:crypto';
import { chmod } from 'node:fs/promises';

const issuer = 'http://localhost:18080/realms/itsaplan-local';
const gateway = 'http://localhost:18081/mcp';
const callback = 'http://localhost:18082/callback';
const clientId = 'shastra-local-browser';
const states = new Map<string, { verifier: string; expires: number }>();
let credentials:
  { access_token: string; refresh_token?: string; expires_in: number; expires: number } | undefined;

async function exchange(fields: Record<string, string>) {
  const response = await fetch(`${issuer}/protocol/openid-connect/token`, {
    method: 'POST',
    body: new URLSearchParams({ client_id: clientId, ...fields }),
  });
  if (!response.ok) throw new Error(`Local OAuth exchange failed (${response.status})`);
  const tokens = (await response.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };
  credentials = { ...tokens, expires: Date.now() + tokens.expires_in * 1000 };
  await Bun.write('.local/v1/mcp-browser-tokens.json', JSON.stringify(credentials));
  await chmod('.local/v1/mcp-browser-tokens.json', 0o600);
}

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 18082,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/login') {
      const state = randomBytes(32).toString('base64url');
      const verifier = randomBytes(32).toString('base64url');
      states.set(state, { verifier, expires: Date.now() + 300_000 });
      const authorization = new URL(`${issuer}/protocol/openid-connect/auth`);
      authorization.search = new URLSearchParams({
        client_id: clientId,
        redirect_uri: callback,
        response_type: 'code',
        scope: 'openid profile email',
        state,
        code_challenge: createHash('sha256').update(verifier).digest('base64url'),
        code_challenge_method: 'S256',
        prompt: 'login',
      }).toString();
      return Response.redirect(authorization.toString());
    }
    if (url.pathname === '/callback') {
      const state = url.searchParams.get('state') ?? '';
      const pending = states.get(state);
      states.delete(state);
      if (!pending || pending.expires < Date.now())
        return new Response('Expired or already used authorization state.', { status: 400 });
      const code = url.searchParams.get('code');
      if (!code || url.searchParams.get('error'))
        return new Response('Authorization cancelled.', { status: 400 });
      try {
        await exchange({
          grant_type: 'authorization_code',
          code,
          redirect_uri: callback,
          code_verifier: pending.verifier,
        });
        return Response.redirect('http://localhost:18082/');
      } catch {
        return new Response('Local authorization failed.', { status: 502 });
      }
    }
    if (url.pathname === '/rpc' && request.method === 'POST') {
      if (
        request.headers.get('origin') &&
        request.headers.get('origin') !== 'http://localhost:18082'
      )
        return new Response('Invalid origin', { status: 403 });
      if (!credentials) return new Response('Sign in first.', { status: 401 });
      try {
        if (credentials.expires <= Date.now() && credentials.refresh_token)
          await exchange({ grant_type: 'refresh_token', refresh_token: credentials.refresh_token });
        const response = await fetch(gateway, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${credentials.access_token}`,
            'content-type': 'application/json',
          },
          body: await request.text(),
        });
        return new Response(await response.text(), {
          status: response.status,
          headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
        });
      } catch {
        return new Response('Local MCP request failed.', { status: 502 });
      }
    }
    return new Response(
      `<!doctype html><html><head><title>Local Shastra MCP test</title></head><body>
<h1>Local Shastra MCP test</h1>
<p>${credentials ? 'Browser OAuth completed. Requests are authenticated by Shastra.' : 'Sign in through local Keycloak to test MCP.'}</p>
<a href="/login">Sign in</a>
<button onclick="rpc('tools/list')">List my MCP tools</button>
<button onclick="rpc('tools/call',{name:'itsaplan__connect',arguments:{}})">Connect my Itsaplan account</button>
<a id="authorize" hidden>Continue to Itsaplan consent</a>
<form onsubmit="event.preventDefault();callTool()">
<p><label>Tool name <input id="tool" required></label></p>
<p><label>Arguments (JSON) <textarea id="arguments">{}</textarea></label></p>
<button>Call tool</button></form><pre id="result"></pre>
<script>
async function rpc(method,params){
const link=document.getElementById('authorize');link.hidden=true;
try{
const r=await fetch('/rpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
const body=await r.text();document.getElementById('result').textContent=body;
if(method==='tools/call' && params.name==='itsaplan__connect'){
const data=JSON.parse(body);for(const item of data.result?.content??[]){
for(const line of (item.text??'').split(String.fromCharCode(10))){
try{const url=new URL(line);if(url.origin==='http://localhost:13000' && url.pathname==='/api/auth/mcp/authorize' && !url.username && !url.password){link.href=url.href;link.hidden=false}}catch{}
}}
}}catch{document.getElementById('result').textContent='Local MCP request failed.'}
}
function callTool(){try{rpc('tools/call',{name:document.getElementById('tool').value,arguments:JSON.parse(document.getElementById('arguments').value)})}catch{document.getElementById('result').textContent='Arguments must be valid JSON.'}}
</script></body></html>`,
      {
        headers: {
          'content-type': 'text/html',
          'cache-control': 'no-store',
          'content-security-policy':
            "default-src 'self'; script-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
        },
      },
    );
  },
});
console.log(`Local MCP browser test: http://localhost:${server.port}`);
