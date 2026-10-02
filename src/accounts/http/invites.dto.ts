import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

export class IssueInviteDto {
  @ApiPropertyOptional({ minimum: 1, maximum: 30, default: 14 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(30)
  expiresInDays?: number;
}
export class InviteIssuedDto {
  @ApiProperty({ description: 'Shown once. Never retrievable again.' })
  code!: string;
  @ApiProperty({ type: String, format: 'date-time' }) expiresAt!: Date;
}
export class InviteListItemDto {
  @ApiProperty() id!: string;
  @ApiProperty({ type: String, format: 'date-time' }) issuedAt!: Date;
  @ApiProperty({ type: String, format: 'date-time' }) expiresAt!: Date;
  @ApiProperty() redeemed!: boolean;
}
