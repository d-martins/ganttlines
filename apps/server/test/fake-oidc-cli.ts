// Runs the test OpenID provider on its own (for the browser tests): node --import tsx apps/server/test/fake-oidc-cli.ts <port>
import { startFakeOidcProvider } from "./fake-oidc";

const provider = await startFakeOidcProvider(Number(process.argv[2] ?? 0));
console.log(`fake-oidc listening: ${provider.issuer} client=${provider.clientId} secret=${provider.clientSecret}`);
