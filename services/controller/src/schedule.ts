import {
  CreateScheduleCommand, DeleteScheduleCommand, SchedulerClient, UpdateScheduleCommand,
  type CreateScheduleCommandInput,
} from '@aws-sdk/client-scheduler';
import type { Drop } from '@dropdeck/shared';

const scheduler = new SchedulerClient({});

const need = (name: string) => {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
};

export const tickScheduleName = (drop: Pick<Drop, 'dropId'>) => `tick-${drop.dropId}`;

/**
 * EventBridge Scheduler cannot fire more often than once a minute, so the controller is re-armed every
 * minute and ticks internally. The schedule ends on its own a little after the last possible hold expiry.
 */
export async function upsertTickSchedule(drop: Drop, controllerArn: string): Promise<void> {
  const input: CreateScheduleCommandInput = {
    Name: tickScheduleName(drop),
    GroupName: process.env.SCHEDULE_GROUP ?? 'default',
    ScheduleExpression: 'rate(1 minute)',
    FlexibleTimeWindow: { Mode: 'OFF' },
    EndDate: new Date(Date.parse(drop.endAt) + drop.holdSec * 1000 + 10 * 60_000),
    Target: {
      Arn: controllerArn,
      RoleArn: need('SCHEDULER_ROLE_ARN'),
      Input: JSON.stringify({ action: 'tick', tenantId: drop.tenantId, dropId: drop.dropId }),
      RetryPolicy: { MaximumRetryAttempts: 0 }, // a lost tick is replaced by the next one within a minute
    },
  };
  try {
    await scheduler.send(new CreateScheduleCommand(input));
  } catch (e) {
    if ((e as { name?: string }).name !== 'ConflictException') throw e;
    await scheduler.send(new UpdateScheduleCommand(input));
  }
}

export async function deleteTickSchedule(drop: Pick<Drop, 'dropId'>): Promise<void> {
  try {
    await scheduler.send(new DeleteScheduleCommand({ Name: tickScheduleName(drop), GroupName: process.env.SCHEDULE_GROUP ?? 'default' }));
  } catch (e) {
    if ((e as { name?: string }).name !== 'ResourceNotFoundException') throw e;
  }
}
