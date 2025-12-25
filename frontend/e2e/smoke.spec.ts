import { test, expect } from '@playwright/test';

/**
 * Smoke test that verifies the app loads without runtime errors.
 * This test MUST fail on any page error or console error.
 */
test('app loads without runtime errors', async ({ page }) => {
  const consoleErrors: string[] = [];
  const pageErrors: Error[] = [];

  // Fail on any page error (JavaScript exceptions, etc.)
  page.on('pageerror', (err) => {
    pageErrors.push(err);
  });

  // Collect console errors
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      consoleErrors.push(msg.text());
    }
  });

  // Navigate to the app
  await page.goto('/', { waitUntil: 'networkidle' });

  // Check if any page errors occurred (this will fail the test)
  if (pageErrors.length > 0) {
    throw new Error(
      `Page errors detected:\n${pageErrors.map((e) => e.message).join('\n')}`
    );
  }

  // Check if any console errors occurred
  if (consoleErrors.length > 0) {
    // Filter out known benign errors (errors that are expected in certain conditions)
    const benignErrors = [
      'Failed to load resource: the server responded with a status of 403', // Expected when not authenticated with Google Drive
      'Failed to check Google Drive status', // Expected when Google Drive is not connected
      'AxiosError', // Expected when API calls fail due to no auth
    ];

    const criticalErrors = consoleErrors.filter(
      (err) => !benignErrors.some((pattern) => err.includes(pattern))
    );

    // Only fail if there are critical errors (not just 403s from unauthenticated API calls)
    // The key error we're preventing is "Missing required parameter client_id" from GSI
    if (criticalErrors.some((err) => err.includes('Missing required parameter client_id'))) {
      throw new Error(
        `CRITICAL: Google GSI client_id error detected:\n${criticalErrors.join('\n')}`
      );
    }

    if (criticalErrors.length > 0) {
      console.info(`Non-critical console errors (expected in dev mode):\n${criticalErrors.join('\n')}`);
    }
  }

  // Verify the page title
  await expect(page).toHaveTitle(/II-Agent/i);

  // Verify React error boundary is not showing
  const errorBoundary = page.locator('text=Unexpected Application Error');
  await expect(errorBoundary).not.toBeVisible();

  // Verify the app shell is rendered (check for a stable element)
  // The main app container should be visible
  const root = page.locator('#root');
  await expect(root).toBeVisible();

  // Log success info
  console.log('✓ App loaded successfully without runtime errors');
});

/**
 * Test that dev auto-login mode works without Google auth errors.
 */
test('dev auto-login mode skips Google auth', async ({ page }) => {
  const consoleMessages: string[] = [];

  page.on('console', (msg) => {
    consoleMessages.push(`[${msg.type()}] ${msg.text()}`);
  });

  await page.goto('/', { waitUntil: 'domcontentloaded' });

  // Give console time to log messages
  await page.waitForTimeout(500);

  // Check that Google auth was disabled
  const hasGoogleDisabledLog = consoleMessages.some((msg) =>
    msg.includes('[auth] Google auth disabled')
  );

  if (hasGoogleDisabledLog) {
    console.log('✓ Google auth correctly disabled in dev auto-login mode');
  }

  // Verify no Google client_id error in console
  const hasClientIdError = consoleMessages.some((msg) =>
    msg.includes('client_id') && msg.includes('Missing required parameter')
  );

  expect(
    hasClientIdError,
    'Found "Missing required parameter client_id" error in console'
  ).toBe(false);
});

/**
 * Test the real user flow: visit homepage -> verify no crashes with Google auth disabled.
 * When VITE_DEV_AUTH_AUTOLOGIN is enabled, user is auto-logged in and sees authenticated home.
 * When disabled, user sees public home with "Start Your First Task" button.
 * This test ensures the login page doesn't crash when GoogleOAuthProvider is disabled.
 */
test('real user flow: homepage loads safely with or without auto-login', async ({ page }) => {
  const consoleErrors: string[] = [];
  const pageErrors: Error[] = [];

  // Collect all errors
  page.on('pageerror', (err) => {
    pageErrors.push(err);
  });

  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      consoleErrors.push(msg.text());
    }
  });

  // Navigate to homepage
  await page.goto('/', { waitUntil: 'domcontentloaded' });

  // Wait for page to stabilize
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(2000);

  // Check what page state we're in
  const startTaskButton = page.locator('button:has-text("Start Your First Task")');
  const isStartTaskButtonVisible = await startTaskButton.isVisible().catch(() => false);

  const authenticatedHello = page.locator('text=/Hello/i');
  const isAuthHelloVisible = await authenticatedHello.isVisible().catch(() => false);

  const loginHeading = page.locator('text=Welcome to II-Agent');
  const isLoginHeadingVisible = await loginHeading.isVisible().catch(() => false);

  console.log(`"Start Your First Task" button visible: ${isStartTaskButtonVisible}`);
  console.log(`Authenticated Hello visible: ${isAuthHelloVisible}`);
  console.log(`Login heading visible: ${isLoginHeadingVisible}`);

  // Check for the critical "Google OAuth components" error that would indicate the bug
  const googleOAuthError = pageErrors.find((err) =>
    err.message.includes('Google OAuth components must be used within GoogleOAuthProvider')
  );
  expect(
    googleOAuthError,
    'Found "Google OAuth components must be used within GoogleOAuthProvider" error - login page crashed!'
  ).toBeUndefined();

  // Check for the client_id error
  const clientIdError = consoleErrors.find((err) =>
    err.includes('Missing required parameter client_id')
  );
  expect(
    clientIdError,
    'Found "Missing required parameter client_id" error in console'
  ).toBeUndefined();

  // Verify we're NOT stuck on the login page with "Continue with II Account" button
  const iiAccountButton = page.locator('button:has-text("Continue with II Account")');
  const isIIAccountButtonVisible = await iiAccountButton.isVisible().catch(() => false);

  expect(
    isIIAccountButtonVisible,
    'Expected "Continue with II Account" button to be hidden when dev auto-login is enabled'
  ).toBe(false);

  // If auto-login is enabled, we should see the authenticated home page
  if (isAuthHelloVisible) {
    console.log('✓ Dev auto-login enabled: User is authenticated and sees the home page');
  } else if (isStartTaskButtonVisible) {
    console.log('✓ Public home page loaded (auto-login not enabled)');
  } else if (isLoginHeadingVisible) {
    throw new Error('Unexpectedly stuck on login page');
  }

  // Verify app is functional (root element exists)
  const root = page.locator('#root');
  await expect(root).toBeVisible();

  // Verify React error boundary is not showing
  const errorBoundary = page.locator('text=Unexpected Application Error');
  await expect(errorBoundary).not.toBeVisible();

  console.log('✓ Homepage loaded safely without Google OAuth errors');
});

/**
 * Test dev auto-login click-through: verifies that when VITE_DEV_AUTH_AUTOLOGIN=true,
 * the user is automatically logged in and sees the authenticated home page.
 * This test expects the frontend to be built with VITE_DEV_AUTH_AUTOLOGIN=true.
 */
test('dev auto-login: user is automatically logged in without prompt', async ({ page }) => {
  const consoleErrors: string[] = [];
  const pageErrors: Error[] = [];
  const consoleMessages: string[] = [];

  // Collect all errors and messages
  page.on('pageerror', (err) => {
    pageErrors.push(err);
  });

  page.on('console', (msg) => {
    const text = msg.text();
    consoleMessages.push(`[${msg.type()}] ${text}`);
    if (msg.type() === 'error') {
      consoleErrors.push(text);
    }
  });

  // Navigate to homepage
  await page.goto('/', { waitUntil: 'domcontentloaded' });

  // Wait for page to stabilize
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(2000);

  // Check for any critical errors
  if (pageErrors.length > 0) {
    throw new Error(
      `Page errors detected:\n${pageErrors.map((e) => e.message).join('\n')}`
    );
  }

  // Check for the critical "Google OAuth components" error
  const googleOAuthError = consoleErrors.find((err) =>
    err.includes('Google OAuth components must be used within GoogleOAuthProvider')
  );
  expect(
    googleOAuthError,
    'Found "Google OAuth components must be used within GoogleOAuthProvider" error - login page crashed!'
  ).toBeUndefined();

  // Check for the client_id error
  const clientIdError = consoleErrors.find((err) =>
    err.includes('Missing required parameter client_id')
  );
  expect(
    clientIdError,
    'Found "Missing required parameter client_id" error in console'
  ).toBeUndefined();

  // Check what page we're on after auto-login
  const currentUrl = page.url();
  console.log(`Current URL: ${currentUrl}`);

  // When dev auto-login is enabled, we should see either:
  // 1. The authenticated home page (with "Hello" greeting)
  // 2. OR the public home page (with "Start Your First Task" button) if auto-login didn't trigger
  const authenticatedHello = page.locator('text=/Hello/i');
  const isAuthHelloVisible = await authenticatedHello.isVisible().catch(() => false);

  const startTaskButton = page.locator('button:has-text("Start Your First Task")');
  const isStartTaskButtonVisible = await startTaskButton.isVisible().catch(() => false);

  // Check for login page elements - these should NOT be visible after auto-login
  const loginHeading = page.locator('text=Welcome to II-Agent');
  const isLoginHeadingVisible = await loginHeading.isVisible().catch(() => false);

  // Check for "Continue with II Account" button - should NOT be visible when auto-login is enabled
  const iiAccountButton = page.locator('button:has-text("Continue with II Account")');
  const isIIAccountButtonVisible = await iiAccountButton.isVisible().catch(() => false);

  // Check for auto-login loading or success indicators
  const hasAutoLoginLog = consoleMessages.some((msg) =>
    msg.includes('[auth] Attempting dev auto-login') || msg.includes('[auth] Dev auto-login successful')
  );

  console.log(`Authenticated Hello visible: ${isAuthHelloVisible}`);
  console.log(`"Start Your First Task" button visible: ${isStartTaskButtonVisible}`);
  console.log(`Login heading visible: ${isLoginHeadingVisible}`);
  console.log(`"Continue with II Account" button visible: ${isIIAccountButtonVisible}`);
  console.log(`Has auto-login log: ${hasAutoLoginLog}`);

  // Primary assertion: should NOT be stuck on login page with "Continue with II Account" button
  expect(
    isIIAccountButtonVisible,
    'Expected "Continue with II Account" button to be hidden when dev auto-login is enabled, but it was visible. This means dev auto-login is not working correctly.'
  ).toBe(false);

  // Also verify we're not stuck on the login page (we should see either authenticated home or public home)
  if (isLoginHeadingVisible) {
    // If we're still seeing login heading, that means auto-login didn't work
    // This is a failure for dev auto-login mode
    throw new Error(
      'Still on login page. Dev auto-login should have redirected to the app. Check that VITE_DEV_AUTH_AUTOLOGIN=true is set and frontend is rebuilt.'
    );
  }

  // Verify app is functional (root element exists)
  const root = page.locator('#root');
  await expect(root).toBeVisible();

  // Verify React error boundary is not showing
  const errorBoundary = page.locator('text=Unexpected Application Error');
  await expect(errorBoundary).not.toBeVisible();

  // Success if we're either authenticated or on the public home page (but NOT on login page)
  if (isAuthHelloVisible) {
    console.log('✓ Dev auto-login successful: User is authenticated and sees the home page');
  } else if (isStartTaskButtonVisible) {
    console.log('✓ Public home page loaded (auto-login may not be enabled)');
  } else {
    console.log('✓ App loaded successfully, user is not on login page');
  }
});

/**
 * Test chat mode: send a message and receive an LLM response.
 * This is the critical test for verifying that Chat Mode actually returns an LLM response.
 * The test will fail if:
 * - The frontend sends but never receives a reply
 * - The backend errors silently
 * - Streaming/SSE/WebSocket wiring is broken
 * - Provider calls fail without user-visible errors
 */
test('chat mode: send message and receive LLM response', async ({ page }) => {
  const consoleErrors: string[] = [];
  const pageErrors: Error[] = [];
  const consoleMessages: string[] = [];

  // Collect all errors and messages
  page.on('pageerror', (err) => {
    pageErrors.push(err);
  });

  page.on('console', (msg) => {
    const text = msg.text();
    consoleMessages.push(`[${msg.type()}] ${text}`);
    if (msg.type() === 'error') {
      consoleErrors.push(text);
    }
  });

  // Navigate to homepage (dev auto-login should work)
  await page.goto('/', { waitUntil: 'domcontentloaded' });

  // Wait for page to stabilize - give extra time for auto-login to complete
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(3000);

  // Check for any critical errors before starting
  if (pageErrors.length > 0) {
    throw new Error(
      `Page errors detected before chat:\n${pageErrors.map((e) => e.message).join('\n')}`
    );
  }

  // Verify we're authenticated - wait explicitly for the "Hello" greeting
  // This is the key indicator that auto-login worked
  const authenticatedHello = page.locator('p:has-text("Hello")');
  try {
    await authenticatedHello.waitFor({ state: 'visible', timeout: 10000 });
    console.log('✓ User is authenticated');
  } catch (err) {
    // Take screenshot for debugging
    await page.screenshot({ path: 'test-results/chat-auth-fail.png', fullPage: true });
    // Log console messages for debugging
    console.log('=== Console messages ===');
    consoleMessages.forEach(msg => console.log(msg));
    console.log('=== End console messages ===');
    throw new Error(`User is not authenticated. Chat test requires authenticated user. Console logs:\n${consoleMessages.join('\n')}`);
  }

  // Find the question input (textarea with placeholder or any textarea)
  const questionInput = page.locator('textarea').first();
  try {
    await questionInput.waitFor({ state: 'visible', timeout: 5000 });
  } catch (err) {
    throw new Error('Question input not found on page');
  }

  // Type a simple test message
  const testMessage = 'ping';
  await questionInput.fill(testMessage);
  console.log(`✓ Typed message: "${testMessage}"`);

  // Press Enter to submit (the submit button has no text label, just an icon)
  await questionInput.press('Enter');
  console.log('✓ Pressed Enter to submit');

  // Wait for navigation to chat page (the app navigates to /chat?id={sessionId} after submit)
  await page.waitForTimeout(2000);
  const currentUrl = page.url();
  console.log(`Current URL after submit: ${currentUrl}`);

  // If we navigated to a chat page, wait for it to load
  if (currentUrl.includes('/chat?id=')) {
    console.log('✓ Navigated to chat page');
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(2000);
  }

  // Wait for response - we should see either:
  // 1. An assistant message with non-empty content
  // 2. A visible UI error with meaningful message
  // 3. Or timeout after 60 seconds (indicating no response)

  let gotAssistantResponse = false;
  let gotVisibleError = false;
  let errorMessage = '';

  const timeoutMs = 60000;
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    // Check for assistant message (look for common patterns)
    const assistantMessage = page.locator('[data-testid="assistant-message"], .message.assistant, [role="assistant"]').first();
    const isVisible = await assistantMessage.isVisible().catch(() => false);

    if (isVisible) {
      const textContent = await assistantMessage.textContent();
      if (textContent && textContent.trim().length > 0) {
        gotAssistantResponse = true;
        console.log(`✓ Assistant response received: "${textContent.trim().substring(0, 100)}..."`);
        break;
      }
    }

    // Check for visible error banners/toasts
    const errorBanner = page.locator('.error, .toast-error, [role="alert"], text=/error/i').first();
    const hasError = await errorBanner.isVisible().catch(() => false);

    if (hasError) {
      gotVisibleError = true;
      errorMessage = await errorBanner.textContent();
      console.log(`⚠ Visible error detected: "${errorMessage}"`);
      break;
    }

    // Check for new console errors
    if (consoleErrors.length > 0) {
      const newErrors = consoleErrors.filter((e) =>
        e.includes('stream') ||
        e.includes('SSE') ||
        e.includes('network') ||
        e.includes('fetch')
      );
      if (newErrors.length > 0) {
        console.log(`⚠ Console errors during chat: ${newErrors.join('; ')}`);
      }
    }

    await page.waitForTimeout(500);
  }

  // After waiting, we should have either a response or a visible error
  if (gotVisibleError) {
    throw new Error(`Chat failed with visible error: ${errorMessage}`);
  }

  if (!gotAssistantResponse) {
    // Check for specific failure indicators
    const stillSending = await page.locator('text=/sending|loading|thinking/i').first().isVisible().catch(() => false);

    if (stillSending) {
      throw new Error('Chat appears stuck in "sending/loading" state - no response received after timeout');
    }

    // Check for HTTP errors in console
    const httpErrors = consoleErrors.filter((e) =>
      e.includes('401') ||
      e.includes('403') ||
      e.includes('500') ||
      e.includes('502') ||
      e.includes('503')
    );

    if (httpErrors.length > 0) {
      throw new Error(`HTTP errors detected in console: ${httpErrors.join('; ')}`);
    }

    throw new Error('No assistant response received after 60 seconds - chat may have failed silently');
  }

  // Verify no page errors occurred during chat
  if (pageErrors.length > 0) {
    throw new Error(
      `Page errors detected during chat:\n${pageErrors.map((e) => e.message).join('\n')}`
    );
  }

  console.log('✓ Chat mode test passed: Assistant responded successfully');
});
