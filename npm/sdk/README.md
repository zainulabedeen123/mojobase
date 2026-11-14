# @mojobase/sdk

> The official JavaScript/TypeScript client for [Mojobase](https://mojobase.dev). Based on the open-source InsForge SDK (Apache-2.0); see NOTICE.

[![npm version](https://img.shields.io/npm/v/@mojobase/sdk.svg)](https://www.npmjs.com/package/@mojobase/sdk)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

Official TypeScript/JavaScript SDK for [Mojobase](https://github.com/zainulabedeen123/mojobase) - A powerful, open-source Backend-as-a-Service (BaaS) platform.

## Features

- **Authentication** - Email/password, OAuth (Google, GitHub), session management
- **Database** - Full PostgreSQL database access with PostgREST
- **Storage** - File upload and management with S3-compatible storage
- **Edge Functions** - Serverless function invocation
- **AI Integration** - Built-in AI capabilities
- **Payments** - Stripe Checkout and Billing Portal session helpers
- **TypeScript** - Full TypeScript support with type definitions
- **Automatic OAuth Handling** - Seamless OAuth callback detection

## Installation

```bash
npm install @mojobase/sdk
```

Or with yarn:

```bash
yarn add @mojobase/sdk
```

## Quick Start

### Initialize the Client

```javascript
import { createClient } from '@mojobase/sdk';

const mojobase = createClient({
  baseUrl: 'http://localhost:7130', // Your Mojobase backend URL
  anonKey: 'your-anon-key', // Optional public anon key
});
```

### Server Admin Client

Use `createAdminClient()` only in trusted server code that needs project-admin privileges:

```typescript
import { createAdminClient } from '@mojobase/sdk';

const admin = createAdminClient({
  baseUrl: 'http://localhost:7130',
  apiKey: process.env.MOJOBASE_API_KEY!,
});
```

`apiKey` belongs in `createAdminClient()`. Public and user-scoped clients use `anonKey`.

### Acting as a User on the Server

In edge functions or other server code that receives a user's JWT, seed the client with it via `accessToken`:

```javascript
const mojobase = createClient({
  baseUrl: 'http://localhost:7130',
  accessToken: userJwt, // e.g. from the request's Authorization header
});
```

All requests run as that user (RLS applies). The token is used as-is — the SDK does not refresh it. `edgeFunctionToken` is a deprecated alias for this option.

### Authentication

```javascript
// Sign up a new user
const { data, error } = await mojobase.auth.signUp({
  email: 'user@example.com',
  password: 'securePassword123',
  name: 'John Doe', // optional
  redirectTo: 'http://localhost:3000/sign-in', // optional, recommended for link-based verification
});

// Sign in with email/password
const { data, error } = await mojobase.auth.signInWithPassword({
  email: 'user@example.com',
  password: 'securePassword123',
});

// OAuth authentication (built-in or custom provider key)
await mojobase.auth.signInWithOAuth('google', {
  redirectTo: 'http://localhost:3000/dashboard',
  additionalParams: { prompt: 'select_account' },
});
// additionalParams is for provider-specific hints only.
// Do not pass client_id, scope, redirect_uri, code_challenge, state, or response_type;
// Mojobase sets server-owned OAuth fields and ignores colliding client-provided keys.

// Get current user (call this during browser app startup)
const { data: currentUser } = await mojobase.auth.getCurrentUser();

// Get any user's profile by ID (public endpoint)
const { data: profile, error } = await mojobase.auth.getProfile('user-id-here');

// Update current user's profile (requires authentication)
const { data: updatedProfile, error } = await mojobase.auth.setProfile({
  displayName: 'John Doe',
  bio: 'Software developer',
  avatarUrl: 'https://example.com/avatar.jpg',
});

// Sign out
await mojobase.auth.signOut();
```

### Email Verification And Password Reset

```javascript
// Resend a verification email
await mojobase.auth.resendVerificationEmail({
  email: 'user@example.com',
  redirectTo: 'http://localhost:3000/sign-in', // optional, recommended for link-based verification
});

// Verify email with a 6-digit code
await mojobase.auth.verifyEmail({
  email: 'user@example.com',
  otp: '123456',
});

// Send password reset email
await mojobase.auth.sendResetPasswordEmail({
  email: 'user@example.com',
  redirectTo: 'http://localhost:3000/reset-password', // optional, recommended for link-based reset
});

// Code-based reset flow: exchange the code, then reset the password
const { data: resetToken } = await mojobase.auth.exchangeResetPasswordToken({
  email: 'user@example.com',
  code: '123456',
});

if (resetToken) {
  await mojobase.auth.resetPassword({
    newPassword: 'newSecurePassword123',
    otp: resetToken.token,
  });
}
```

For link-based verification and password reset, users click the emailed browser links:

- `GET /api/auth/email/verify-link`
- `GET /api/auth/email/reset-password-link`

Those backend endpoints validate the token first, then redirect the browser to your `redirectTo` URL.

- Verification links redirect with `insforge_status=success|error`, `insforge_type=verify_email`, and optional `insforge_error`
- Recommended: use your sign-in page as the verification `redirectTo`, then show a confirmation message and ask the user to sign in with email and password
- Reset links redirect with `token` when ready, plus `insforge_status=ready|error`, `insforge_type=reset_password`, and optional `insforge_error`

### Database Operations

```javascript
// Insert data
const { data, error } = await mojobase.database
  .from('posts')
  .insert([{ title: 'My First Post', content: 'Hello World!' }]);

// Query data
const { data, error } = await mojobase.database.from('posts').select('*').eq('author_id', userId);

// Update data
const { data, error } = await mojobase.database
  .from('posts')
  .update({ title: 'Updated Title' })
  .eq('id', postId);

// Delete data
const { data, error } = await mojobase.database.from('posts').delete().eq('id', postId);
```

#### Selecting a schema

Queries hit the `public` schema by default. Target a custom schema by chaining `.schema()` — the table name stays bare (it maps to PostgREST's `Accept-Profile`/`Content-Profile` header):

```javascript
const { data } = await mojobase.database.schema('analytics').from('events').select('*');

await mojobase.database.schema('analytics').rpc('rollup', { day: '2026-01-01' });
```

Or set a default schema for every query when creating the client:

```javascript
const mojobase = createClient({
  baseUrl: '...',
  anonKey: '...',
  db: { schema: 'analytics' },
});
```

The schema must be exposed by the backend, and access is still gated by grants + RLS like `public`. Older backends that don't expose the schema return PostgREST `PGRST106` rather than silently falling back.

### File Storage

```javascript
// Upload a file
const file = document.querySelector('input[type="file"]').files[0];
const { data, error } = await mojobase.storage.from('avatars').upload(file);

// Download a file
const { data, error } = await mojobase.storage.from('avatars').download('user-avatar.png');

// Delete a file
const { data, error } = await mojobase.storage.from('avatars').remove('user-avatar.png');

// Delete multiple files (maximum 1000 keys)
const { data, error } = await mojobase.storage
  .from('avatars')
  .remove(['user-avatar.png', 'old-avatar.png']);
// data: { results: [{ key, status: 'deleted' | 'notFound' | 'failed', message? }] }

// List files
const { data, error } = await mojobase.storage.from('avatars').list();
```

### Edge Functions

```javascript
// Invoke an edge function
const { data, error } = await mojobase.functions.invoke('my-function', {
  body: { key: 'value' },
});
```

### Payments

```javascript
// Create and redirect to a Stripe Checkout Session
const { data, error } = await mojobase.payments.stripe.createCheckoutSession('test', {
  mode: 'payment',
  lineItems: [{ priceId: 'price_123', quantity: 1 }],
  successUrl: `${window.location.origin}/success`,
  cancelUrl: `${window.location.origin}/pricing`,
  idempotencyKey: 'cart_123',
});

if (!error && data?.checkoutSession.url) {
  window.location.assign(data.checkoutSession.url);
}

// Create a subscription checkout for an app billing subject
const { data: subscriptionCheckout } = await mojobase.payments.stripe.createCheckoutSession(
  'test',
  {
    mode: 'subscription',
    subject: { type: 'team', id: 'team_123' },
    lineItems: [{ priceId: 'price_monthly_123', quantity: 1 }],
    successUrl: `${window.location.origin}/billing/success`,
    cancelUrl: `${window.location.origin}/billing`,
  }
);

if (subscriptionCheckout?.checkoutSession.url) {
  window.location.assign(subscriptionCheckout.checkoutSession.url);
}

// Let an authenticated customer manage their subscription in Stripe Billing Portal
const { data: portal } = await mojobase.payments.stripe.createCustomerPortalSession('test', {
  subject: { type: 'team', id: 'team_123' },
  returnUrl: `${window.location.origin}/billing`,
});

if (portal?.customerPortalSession.url) {
  window.location.assign(portal.customerPortalSession.url);
}

// Create a Razorpay order, then pass checkoutOptions to Razorpay Checkout.js
const { data: order } = await mojobase.payments.razorpay.createOrder('test', {
  amount: 200000,
  currency: 'INR',
  subject: { type: 'team', id: 'team_123' },
  customerEmail: 'ada@example.com',
  notes: { order_id: 'order_123' },
});

if (order) {
  const checkout = new Razorpay({
    ...order.checkoutOptions,
    handler: async (response) => {
      await mojobase.payments.razorpay.verifyOrder('test', {
        orderId: response.razorpay_order_id,
        paymentId: response.razorpay_payment_id,
        signature: response.razorpay_signature,
      });
    },
  });
  checkout.open();
}

// Create a Razorpay subscription checkout for an app billing subject
const { data: subscription } = await mojobase.payments.razorpay.createSubscription('test', {
  planId: 'plan_123',
  totalCount: 12,
  subject: { type: 'team', id: 'team_123' },
  notes: { order_id: 'order_123' },
});
```

### AI Integration

AI methods return an OpenAI-like response object directly (not the `{ data, error }` envelope used by the other modules) and throw on failure.

```javascript
// Chat completion
const completion = await mojobase.ai.chat.completions.create({
  model: 'anthropic/claude-3.5-haiku',
  messages: [{ role: 'user', content: 'Write a hello world program' }],
});
console.log(completion.choices[0].message.content);

// Streaming chat — returns an async iterable of chunks
const stream = await mojobase.ai.chat.completions.create({
  model: 'anthropic/claude-3.5-haiku',
  messages: [{ role: 'user', content: 'Tell me a story' }],
  stream: true,
});
for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content ?? '');
}

// Generate an image — returns base64-encoded image data
const image = await mojobase.ai.images.generate({
  model: 'google/gemini-3-pro-image-preview',
  prompt: 'A sunset over mountains',
});
const base64Png = image.data[0].b64_json;

// Create embeddings
const embeddings = await mojobase.ai.embeddings.create({
  model: 'openai/text-embedding-3-small',
  input: 'Hello world',
});
console.log(embeddings.data[0].embedding); // number[]
```

## Documentation

For complete API reference and advanced usage, see:

- **[SDK Reference](./SDK-REFERENCE.md)** - Complete API documentation
- **[Mojobase Main Repository](https://github.com/zainulabedeen123/mojobase)** - Backend platform and setup guides

## Configuration

The SDK supports the following configuration options:

```javascript
const mojobase = createClient({
  baseUrl: 'http://localhost:7130', // Your Mojobase backend URL
  anonKey: 'your-anon-key', // Optional
});
```

For project-admin keys, use `createAdminClient({ apiKey })` in server-only code.

### SSR / Next.js

Use `@mojobase/sdk/ssr` for apps that need the same auth session in Server Components, Client Components, Storage, and Realtime.
The helper uses explicit `baseUrl` / `anonKey` when provided. Otherwise it reads `NEXT_PUBLIC_MOJOBASE_URL` / `NEXT_PUBLIC_MOJOBASE_ANON_KEY`. Missing config throws a clear error.

By default, the SSR helpers use:

- `insforge_access_token`: browser-readable access token cookie, expires at the JWT `exp`
- `insforge_refresh_token`: httpOnly refresh token cookie, expires at the JWT `exp`

```typescript
// app/lib/mojobase/client.ts
import { createBrowserClient } from '@mojobase/sdk/ssr';

export const mojobase = createBrowserClient();
```

`createBrowserClient()` is for Client Components that consume an existing SSR
session. Its TypeScript surface does not include auth mutations such as
`signInWithPassword()`, `signUp()`, or `signOut()`. Run auth mutations on the
server so the app can write server-owned auth cookies.

```typescript
// app/lib/mojobase/server.ts
import { cookies } from 'next/headers';
import { createServerClient } from '@mojobase/sdk/ssr';

export async function createMojobaseServerClient() {
  return createServerClient({ cookies: await cookies() });
}
```

```typescript
// app/api/auth/refresh/route.ts
import { createRefreshAuthRouter } from '@mojobase/sdk/ssr';

export const { POST } = createRefreshAuthRouter();
```

For sign-in, sign-up, and sign-out, use `createAuthActions()` in a Server
Action file. Server Actions are stable in Next.js 14+. Do not return raw auth
responses from Server Actions; return only the user or app-specific safe fields
so access and refresh tokens stay server-owned.

```typescript
// app/actions.ts
'use server';

import { cookies } from 'next/headers';
import { createAuthActions } from '@mojobase/sdk/ssr';

export async function signIn(formData: FormData) {
  const auth = createAuthActions({ cookies: await cookies() });

  const { data, error } = await auth.signInWithPassword({
    email: String(formData.get('email')),
    password: String(formData.get('password')),
  });

  return { user: data?.user ?? null, error };
}
```

For OAuth in SSR apps, start and finish the flow on the server. Store the PKCE
verifier in an httpOnly app cookie and exchange the callback code with
`createAuthActions()`:

```typescript
// app/actions.ts
'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { createAuthActions } from '@mojobase/sdk/ssr';

export async function signInWithGoogle() {
  const cookieStore = await cookies();
  const auth = createAuthActions({ cookies: cookieStore });
  const { data, error } = await auth.signInWithOAuth('google', {
    redirectTo: new URL('/api/auth/callback', process.env.NEXT_PUBLIC_APP_URL).toString(),
    skipBrowserRedirect: true,
  });

  if (error || !data.url || !data.codeVerifier) {
    throw new Error(error?.message ?? 'OAuth init failed');
  }

  cookieStore.set('insforge_code_verifier', data.codeVerifier, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 600,
  });

  redirect(data.url);
}
```

```typescript
// app/api/auth/callback/route.ts
import { cookies } from 'next/headers';
import { NextResponse, type NextRequest } from 'next/server';
import { createAuthActions } from '@mojobase/sdk/ssr';

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get('insforge_code');
  const verifier = (await cookies()).get('insforge_code_verifier')?.value;
  if (!code || !verifier) {
    return NextResponse.redirect(new URL('/login?error=oauth', request.url));
  }

  const response = NextResponse.redirect(new URL('/dashboard', request.url));
  const auth = createAuthActions({
    requestCookies: request.cookies,
    responseCookies: response.cookies,
  });
  const { error } = await auth.exchangeOAuthCode(code, verifier);
  if (error) {
    return NextResponse.redirect(new URL('/login?error=oauth', request.url));
  }

  response.cookies.delete('insforge_code_verifier');
  return response;
}
```

SSR browser clients do not exchange OAuth callbacks automatically. OAuth
callbacks must be completed on the server so the refresh token lands in the
httpOnly app cookie.

For Route Handlers, pass request cookies for reading the current session and
response cookies for writing the next session:

```typescript
// app/api/auth/sign-out/route.ts
import { NextResponse, type NextRequest } from 'next/server';
import { createAuthActions } from '@mojobase/sdk/ssr';

export async function POST(request: NextRequest) {
  const response = NextResponse.json({ ok: true });
  const auth = createAuthActions({
    requestCookies: request.cookies,
    responseCookies: response.cookies,
  });

  const { error } = await auth.signOut();
  if (error) {
    return NextResponse.json(
      { error: error.error, message: error.message },
      { status: error.statusCode }
    );
  }

  return response;
}
```

If your refresh route needs custom side effects:

```typescript
import { refreshAuth } from '@mojobase/sdk/ssr';

export async function POST(request: Request) {
  const result = await refreshAuth({ request });
  // run app-specific side effects here
  return result.response;
}
```

For Next.js Proxy/Middleware, refresh before Server Components render:

```typescript
// proxy.ts on Next.js 16+, middleware.ts on Next.js 15 and earlier
import { NextResponse, type NextRequest } from 'next/server';
import { updateSession } from '@mojobase/sdk/ssr/middleware';

export async function proxy(request: NextRequest) {
  const response = NextResponse.next({ request });

  await updateSession({
    requestCookies: request.cookies,
    responseCookies: response.cookies,
  });

  return response;
}
```

Use the `/ssr/middleware` subpath in Proxy/Middleware files. It only includes
the session refresh helpers and avoids bundling the full SDK client.

## TypeScript Support

The SDK is written in TypeScript and provides full type definitions:

```typescript
import { createClient, MojobaseClient } from '@mojobase/sdk';

const mojobase: MojobaseClient = createClient({
  baseUrl: 'http://localhost:7130',
});

// Type-safe API calls
const response = await mojobase.auth.getCurrentUser();
```

## Error Handling

All SDK methods return a consistent response format:

```javascript
const { data, error } = await mojobase.auth.signUp({...});

if (error) {
  console.error('Error:', error.message);
  console.error('Status:', error.statusCode);
} else {
  console.log('Success:', data);
}
```

## Browser Support

The SDK works in all modern browsers that support:

- ES6+ features
- Fetch API
- Cookies (for refresh token flow)

For Node.js environments, ensure you're using Node.js 18 or higher.

## Contributing

We welcome contributions! Please see our [Contributing Guide](./CONTRIBUTING.md) for details.

### Development Setup

```bash
# Clone the repository
git clone https://github.com/zainulabedeen123/mojobase
cd mojobase/npm/sdk

# Install dependencies
npm install

# Build the SDK
npm run build

# Run tests
npm test

# Run integration tests
npm run test:integration
```

## License

This project is licensed under the Apache License 2.0 - see the [LICENSE](./LICENSE) file for details.

## Community & Support

- **GitHub Issues**: [Report bugs or request features](https://github.com/zainulabedeen123/mojobase/issues)
- **Documentation**: [https://docs.insforge.com](https://docs.insforge.com)
- **Main Repository**: [Mojobase Backend Platform](https://github.com/zainulabedeen123/mojobase)

## Related Projects

- **[Mojobase](https://github.com/zainulabedeen123/mojobase)** - The main Mojobase backend platform
- **[Mojobase MCP](https://github.com/zainulabedeen123/mojobase)** - Model Context Protocol server for Mojobase

---

Built with ❤️ by the Mojobase team
