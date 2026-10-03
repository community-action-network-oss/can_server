import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsUUID } from 'class-validator';

export class FollowRequestDto {
  @ApiProperty({
    description:
      'A public problem. Following is always your own explicit choice.',
  })
  @IsUUID()
  problemId!: string;

  @ApiProperty({
    description:
      'True records consent (purpose problem_updates_email) and sends update emails for this follow. False follows in the app only.',
  })
  @IsBoolean()
  emailUpdates!: boolean;
}

export class FollowDto {
  @ApiProperty() problemId!: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The public title.',
  })
  title!: string | null;
  @ApiProperty() followedAt!: string;
  @ApiProperty() muted!: boolean;
  @ApiProperty() emailUpdates!: boolean;
}

export class FollowListDto {
  @ApiProperty({ type: [FollowDto] }) items!: FollowDto[];
}

export class NotificationDto {
  @ApiProperty() id!: string;
  @ApiProperty() problemId!: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The public title.',
  })
  problemTitle!: string | null;
  @ApiProperty({
    enum: [
      'state_changed',
      'stage_changed',
      'plan_changed',
      'decision_recorded',
      'task_updated',
      'reopened',
    ],
  })
  kind!: string;
  @ApiProperty({ description: 'Fixed public wording, never user text.' })
  label!: string;
  @ApiProperty() createdAt!: string;
  @ApiProperty() read!: boolean;
}

export class NotificationPageDto {
  @ApiProperty({ type: [NotificationDto] }) items!: NotificationDto[];
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
}
