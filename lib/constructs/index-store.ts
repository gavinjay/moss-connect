import { RemovalPolicy, Duration } from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

export interface IndexStoreProps {
  readonly retainOnDelete: boolean;
}

/**
 * Versioned store for built Moss index artifacts, plus the manifest that names
 * the live version.
 *
 * S3 object versioning is on deliberately: when a bad index reaches production
 * the fix is to repoint the manifest at the previous version, which has to still
 * exist. Rolling back by rebuilding is not a rollback.
 */
export class IndexStore extends Construct {
  public readonly bucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: IndexStoreProps) {
    super(scope, id);

    this.bucket = new s3.Bucket(this, 'Bucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true,
      removalPolicy: props.retainOnDelete ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
      lifecycleRules: [
        {
          id: 'expire-superseded-index-versions',
          noncurrentVersionExpiration: Duration.days(90),
          abortIncompleteMultipartUploadAfter: Duration.days(7),
        },
      ],
    });
  }
}
