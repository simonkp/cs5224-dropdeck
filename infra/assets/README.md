# Sign-in page branding

The merchant sign-in page is Cognito's managed login (version 2). Its look is a `AWS::Cognito::ManagedLoginBranding` resource in `infra/lib/dropdeck-stack.ts`, built from the files here:

| File | What it is |
| --- | --- |
| `managed-login.json` | The style settings (colours, corners, fonts). Without it, the stack uses Cognito's default style. |
| `login-logo-light.png`, `login-logo-dark.png` | The logo above the form, for light and dark mode (optional). |
| `favicon.ico` | Browser tab icon (optional). |

The settings format is long and mostly undocumented, so don't write it by hand. To change the style:

1. Deploy your own stage and open **Cognito → User pools → (your pool) → Branding → Managed login** in the AWS console.
2. Edit the style in the visual editor and save.
3. Export it:

   ```bash
   aws cognito-idp describe-managed-login-branding-by-client \
     --user-pool-id <pool id> --client-id <console client id> \
     --query 'ManagedLoginBranding.Settings' > infra/assets/managed-login.json
   ```

4. Commit the file and deploy. From then on, CDK sets the style on every stage.

The current file is Cognito's default style with DropDeck's colours applied: ink buttons and links on a light grey page, volt buttons in dark mode, rounder corners, and it follows the phone's light or dark setting (`colorSchemeMode: DYNAMIC`). Small colour edits can be made in the JSON directly; colours are `rrggbbaa`.
