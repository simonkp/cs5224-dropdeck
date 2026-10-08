# Putting DropDeck on our own domain

The site works today on its `*.cloudfront.net` address. A domain gives it a real address, and it lets us send email from our own name, which removes the sign-up email cap. Do this **before STEPS**. Allow a few days, because SES production access is approved by AWS, not by us.

Everything is set per stage in `infra/cdk.json` under `stageSettings`, so CI deploys staging with it. The examples use `example.com`; replace it with ours. Commands use the sandbox profile:

```bash
export AWS_PROFILE=dropdeck-uni AWS_REGION=ap-southeast-1
```

Checked on 2026-10-08:
- ACM works in us-east-1 from the sandbox.
- SES in ap-southeast-1 is still in the sandbox: 200 emails a day, only to verified addresses.

## 0. Pick the names

| Use | Suggested name | Why |
| --- | --- | --- |
| The site | `drops.example.com` (or `www.`) | A subdomain needs only a CNAME, which any registrar supports. |
| Email sender | `codes@example.com` | Verifying the whole domain lets any address on it send. |

**The bare domain (`example.com`):** most registrars cannot point it at CloudFront with a CNAME. Pick one:
- Forward it to `https://drops.example.com` in the registrar's settings (easy).
- Use a registrar with ALIAS/ANAME records or CNAME flattening, such as Cloudflare.
- Move DNS to Route 53, which costs US$0.50 a month.

## 1. Certificate for the site (once)

CloudFront only accepts certificates from us-east-1, whatever region the rest runs in.

```bash
aws acm request-certificate --region us-east-1 --domain-name drops.example.com --validation-method DNS \
  --query CertificateArn --output text
# → arn:aws:acm:us-east-1:337542796977:certificate/…

aws acm describe-certificate --region us-east-1 --certificate-arn <arn> \
  --query "Certificate.DomainValidationOptions[0].ResourceRecord"
# → { Name: _abc.drops.example.com., Type: CNAME, Value: _xyz.acm-validations.aws. }
```

1. At the registrar, add that CNAME. Some registrars want only the `_abc.drops` part of the name.
2. Wait for `Status` to become `ISSUED`, usually minutes: `aws acm describe-certificate … --query Certificate.Status`
3. Keep the CNAME. ACM uses it to renew the certificate every year.

## 2. Point the site at the domain

In `infra/cdk.json`, under `context`:

```json
"stageSettings": {
  "staging": {
    "domainName": "drops.example.com",
    "certificateArn": "arn:aws:acm:us-east-1:337542796977:certificate/…"
  }
}
```

1. Deploy (dev-simon first, by our deploy order, if you are trying it there). Then push to `main` so CI deploys staging.
2. Find the CloudFront name in the stack outputs: `CloudFrontDomain`, for example `d1n4z7b90ypcvj.cloudfront.net`.
3. At the registrar, add `drops` CNAME `d1n4z7b90ypcvj.cloudfront.net`.

**What changes automatically:**
- The site answers on `https://drops.example.com`.
- `config.json` gives that as `siteUrl`.
- Sign-in accepts both addresses.
- The API allows both as origins.
- The cloudfront.net address keeps working, so links already shared do not break.

**Check:**

```bash
curl -sI https://drops.example.com/ | head -1        # HTTP/2 200
```

Then open `https://drops.example.com/m/` and sign in.

## 3. Send email from the domain

Add `sesDomain` (the domain, not the subdomain) and deploy:

```json
"staging": { "domainName": "…", "certificateArn": "…", "sesDomain": "example.com" }
```

1. The stack outputs `DkimRecord1` … `DkimRecord3`, each `name CNAME value`. Add all three at the registrar. SES marks the domain verified once it sees them, usually within an hour.
2. Recommended: add a DMARC record so mail is less likely to be filtered: TXT `_dmarc.example.com` = `v=DMARC1; p=none;`
3. Check: `aws sesv2 get-email-identity --email-identity example.com --query VerifiedForSendingStatus`, which should print `true`.
4. Turn on SES for buyer email codes by adding `"mailFrom": "DropDeck <codes@example.com>"` to the stage settings and deploying.
   - Until production access (next step), SES only delivers to addresses verified in SES.
   - For a test, verify your own address with `aws sesv2 create-email-identity --email-identity you@example.com` and click the link it sends.

## 4. SES production access (needs AWS's approval)

In the AWS console, go to **SES → Account dashboard → Request production access**:
- **Mail type:** Transactional.
- **Website:** `https://drops.example.com`.
- **Use case:** one-time sign-in and checkout codes and account emails for DropDeck, a drop and queue service for small Singapore shops. Codes are sent only to buyers who have reserved stock (a few hundred per drop), and to merchants signing up.
- **Bounces and complaints:** SES suppression list on; no marketing email.

It is usually answered within a day. Approval lifts the verified-recipient rule and raises the 200-a-day quota.

## 5. Sign-up emails through SES

Cognito's built-in sender allows about 50 emails a day. That is fine for a pilot, but not for STEPS.

**Only after production access**, add `"signupEmailFromSes": true` and deploy. Cognito then sends verification and password-reset emails from `mailFrom` through SES. Turning it on earlier makes sign-ups from unverified addresses fail.

## 6. Optional: sign-in page on the domain

The sign-in page stays on `dropdeck-<stage>-<account>.auth.ap-southeast-1.amazoncognito.com`, which works and is branded. Moving it to `login.example.com` needs:
- a second us-east-1 certificate
- a Cognito custom domain
- updates to `authDomain`
- adding the new host to the CSP `connect-src`

That is not worth it for the project.

## Order of work, and what to tell the team

| When | Step |
| --- | --- |
| Day 0 | Buy the domain. Steps 1 and 2 (the site is live on it within the hour). Step 3 (DKIM). Step 4 (request production access). |
| Day 1–2 | Production access arrives. `mailFrom` for buyer codes, then step 5 for sign-ups. |
| Before STEPS | `pnpm demo:reset -- staging <email>` with `FORCE=1`, then check sign-up from a fresh email address end to end. |
