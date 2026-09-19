import { Tags } from 'aws-cdk-lib';
import type { IConstruct } from 'constructs';
import type { TagConfig } from '../src/config/deploy-config';

/**
 * TrackIt tagging compliance -- REQUIRED on every AWS resource.
 *
 * This lives in a function rather than inline in bin/ so the stack test can
 * apply the exact same tags the real deploy applies. Tagging written only in the
 * entry point is tagging nothing verifies, and a missing tag gets resources
 * stopped or terminated by the Terminator Bot regardless of intent.
 *
 * Never apply these via the AWS CLI: CLI-applied tags drift off on the next
 * deploy.
 */
export function applyTrackItTags(scope: IConstruct, tags: TagConfig): void {
  Tags.of(scope).add('Project', tags.project);
  Tags.of(scope).add('Owner', tags.owner);
  Tags.of(scope).add('TrackitPersistent', 'yes');
  Tags.of(scope).add('aws-apn-id', tags.awsApnId);
}
