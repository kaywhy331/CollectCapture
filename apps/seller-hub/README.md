# LocalClear Seller Hub

Physical Android 11+ companion for policy-approved, deterministic marketplace connector modules. It never accepts arbitrary UI scripts and never uploads marketplace passwords, cookies, session databases, or MFA secrets.

Build prerequisites:

- Android Studio with API 37 installed
- JDK 17
- The checked-in Gradle wrapper (Gradle 9.4.1 with distribution checksum verification)
- A P-256 command-signing public key, base64-encoded DER, supplied as `LOCALCLEAR_COMMAND_PUBLIC_KEY_BASE64`
- The matching API key identifier supplied as `LOCALCLEAR_COMMAND_KEY_ID`

Example local properties (do not commit real credentials):

```properties
LOCALCLEAR_COMMAND_PUBLIC_KEY_BASE64=BASE64_DER_PUBLIC_KEY
LOCALCLEAR_COMMAND_KEY_ID=backend-2026-08
```

Generate a matching development pair with OpenSSL, store the PEM private key only in the API secret manager as `DEVICE_COMMAND_SIGNING_PRIVATE_KEY`, and place only the DER public key in Android configuration:

```sh
openssl ecparam -name prime256v1 -genkey -noout -out device-command-private.pem
openssl ec -in device-command-private.pem -pubout -outform DER | base64 | tr -d '\n'
```

Never commit either a real private key or populated `local.properties`.

Only `Sandbox Seller Hub` version `1.0.0` is executable in this repository. Adding a production connector requires a code-reviewed module, policy approval evidence, version canaries, and a server-side enabled manifest.
