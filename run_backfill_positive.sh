VERCEL IS NOT THE DATABASE MIGRATION TOOL.

For now:
1. You may connect your existing Operro GitHub repository to Vercel.
2. Use a Preview deployment only.
3. Do not point production users to the new staging database yet.
4. The application SDK/backend still needs the Batch 2 compatibility work for migration 0013.
5. Do not paste a database password or Supabase service-role secret into a public GitHub file.

When the application code is ready, set environment variables inside:
Vercel Project > Settings > Environment Variables.
Use the variable names already referenced by your app's source code or .env.example.
