# Automated-Cloud-Media-Ingestion-Pipeline

## Local development

1. Copy `.env.example` to `.env` and set `LOCALSTACK_AUTH_TOKEN` to a valid token from your LocalStack account.
2. Start the services with `docker compose up -d`.
3. Check that LocalStack is running with `docker compose ps localstack`, then try `awslocal s3 ls`.

Keep `.env` private and do not commit it. Revoke and replace any token that has been exposed.

### Frontend

With LocalStack and Postgres running, start the Next.js dashboard:

```sh
cd frontend
npm install
npm run dev
```

Open `http://localhost:3000`. The dashboard uploads video to the `raw-videos` bucket and reads processing records from Postgres. Keep the worker running in a separate terminal with `cd worker && go run .`.