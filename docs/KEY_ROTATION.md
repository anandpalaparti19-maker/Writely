# Rule 10: Key Rotation & Secret Management

To ensure the security of the Writely production environment, especially after the initial development phase, you MUST rotate the sensitive keys that have been exposed in environment variables.

## 🚨 Required Rotations

### 1. Firebase Service Account Key
**Risk**: If this key is leaked, an attacker has full administrative access to your Firestore and Auth.

**How to Rotate**:
1. Go to the [Firebase Console](https://console.firebase.google.com/).
2. Navigate to **Project Settings** > **Service Accounts**.
3. Click **Generate new private key**.
4. Download the JSON.
5. Base64 encode the JSON string:
   ```bash
   # On Windows (PowerShell)
   [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes((Get-Content your-new-key.json -Raw)))
   ```
6. Update `FIREBASE_SERVICE_ACCOUNT` in your `.env` file with the new base64 string.
7. Delete the old key from the Firebase Console.

### 2. Cashfree Secret Key
**Risk**: Unauthorized access could allow an attacker to intercept webhooks or initiate fraudulent refunds.

**How to Rotate**:
1. Log in to your [Cashfree Dashboard](https://merchant.cashfree.com/merchant/pg).
2. Go to **Developers** > **API Keys**.
3. Click **Regenerate Secret Key**.
4. Update `CASHFREE_SECRET_KEY` in your `.env` file immediately.
5. Update your production environment variables (e.g., on Render or Netlify).

### 3. Google GenAI API Key
**Risk**: Unauthorized usage could result in unexpected costs on your Google Cloud bill.

**How to Rotate**:
1. Go to [Google AI Studio](https://aistudio.google.com/app/apikey).
2. Create a new key.
3. Update `GOOGLE_GENAI_API_KEY` in your `.env` file.
4. Delete the old key.

---

## 🔒 Best Practices for Secrets
- **Never commit `.env`**: Ensure it stays in `.gitignore`.
- **Use CI/CD Secrets**: In production (Render/Netlify), use their built-in environment variable managers instead of a `.env` file.
- **Principle of Least Privilege**: Ensure the service account has only the permissions it needs (e.g., `Firestore Admin`, `Firebase Auth Admin`).
