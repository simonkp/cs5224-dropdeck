const need = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
};

export const env = {
  table: () => need('TABLE_NAME'),
  bucket: () => need('BUCKET_NAME'),
  controllerArn: () => need('CONTROLLER_ARN'),
  schedulerRoleArn: () => need('SCHEDULER_ROLE_ARN'),
  scheduleGroup: () => process.env.SCHEDULE_GROUP ?? 'default',
};
