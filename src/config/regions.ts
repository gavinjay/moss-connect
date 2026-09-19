/**
 * Amazon Connect is NOT available in every AWS region -- notably NOT in
 * us-east-2 (Ohio), which is where the sibling `jarvis` project lives.
 *
 * Deploying this stack to an unsupported region does not fail with an obvious
 * "service not available" error. It fails later, partially, in ways that look
 * like IAM or account problems. So we fail closed at synth time instead.
 *
 * Verified against the AWS service endpoint table for Amazon Connect
 * (docs.aws.amazon.com/general/latest/gr/connect_region.html).
 * Re-verify when adding a region: AWS adds them over time.
 */
export const CONNECT_SUPPORTED_REGIONS = [
  'us-east-1',      // US East (N. Virginia)
  'us-west-2',      // US West (Oregon)
  'af-south-1',     // Africa (Cape Town)
  'ap-northeast-1', // Asia Pacific (Tokyo)
  'ap-northeast-2', // Asia Pacific (Seoul)
  'ap-southeast-1', // Asia Pacific (Singapore)
  'ap-southeast-2', // Asia Pacific (Sydney)
  'ca-central-1',   // Canada (Central)
  'eu-central-1',   // Europe (Frankfurt)
  'eu-west-2',      // Europe (London)
  'us-gov-west-1',  // AWS GovCloud (US-West)
] as const;

export type ConnectRegion = (typeof CONNECT_SUPPORTED_REGIONS)[number];

export function isConnectRegion(region: string): region is ConnectRegion {
  return (CONNECT_SUPPORTED_REGIONS as readonly string[]).includes(region);
}

/** Throws with an actionable message rather than letting a bad region deploy. */
export function assertConnectRegion(region: string): ConnectRegion {
  if (!isConnectRegion(region)) {
    throw new Error(
      `Amazon Connect is not available in "${region}".\n` +
        `Supported: ${CONNECT_SUPPORTED_REGIONS.join(', ')}.\n` +
        (region === 'us-east-2'
          ? 'Note: us-east-2 is where the `jarvis` stack lives. Connect is not there. Use us-west-2.'
          : 'Set mossConnect.region in cdk.json to a supported region.'),
    );
  }
  return region;
}
