# factory-assets

Storage and delivery for the /factory artwork, so no image binary lives in Git
or GitHub. The bucket is private; viewing through CloudFront is public.

- `cert.yaml`: ACM certificate for `assets.simostack.com`. Stack
  `factory-assets-cert`, us-east-1.
- `site.yaml`: private bucket `simostack-factory-assets-<account>` (Block
  Public Access on, BucketOwnerEnforced, SSE-S3, versioning), OAC, and a
  dedicated CloudFront distribution at `assets.simostack.com`. Stack
  `factory-assets-site`, ap-southeast-2. Separate from the site distribution,
  whose deploy runs `s3 sync --delete` against its own bucket.

Key scheme: `factory/v1/<file>.webp`. Versions are immutable; ship `v2/` rather
than invalidating. Originals are not uploaded. vue-simostack reads
`VITE_FACTORY_ASSET_BASE` from the `FACTORY_ASSET_BASE` repo variable; unset
means placeholders.

Deploy (no Lambda, so plain CloudFormation rather than SAM):

```bash
aws cloudformation deploy --region us-east-1 --stack-name factory-assets-cert \
  --template-file cert.yaml --parameter-overrides HostedZoneId=<simostack.com zone>
aws cloudformation deploy --region ap-southeast-2 --stack-name factory-assets-site \
  --template-file site.yaml --parameter-overrides \
  CertificateArn=<factory-assets-cert CertificateArn> HostedZoneId=<simostack.com zone>
aws s3 sync <staging>/v1 s3://simostack-factory-assets-<account>/factory/v1/ \
  --cache-control "public,max-age=31536000,immutable" --content-type image/webp
```
