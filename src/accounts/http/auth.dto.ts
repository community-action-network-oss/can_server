import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEmail,
  IsString,
  Length,
  MaxLength,
} from 'class-validator';

export class SignUpDto {
  @ApiProperty() @IsString() @Length(1, 128) inviteCode!: string;
  @ApiProperty() @IsEmail() @MaxLength(254) email!: string;
  @ApiProperty() @IsBoolean() ageConfirmed!: boolean;
}
export class RequestCodeDto {
  @ApiProperty() @IsEmail() @MaxLength(254) email!: string;
}
export class VerifyDto {
  @ApiProperty() @IsEmail() @MaxLength(254) email!: string;
  @ApiProperty() @IsString() @Length(1, 16) code!: string;
}

export class SignUpResponseDto {
  @ApiProperty() accepted!: boolean;
}
export class CodeRequestedDto {
  @ApiProperty() message!: string;
}
export class VerifyResponseDto {
  @ApiProperty() handle!: string;
  @ApiProperty() role!: string;
  @ApiPropertyOptional({
    description: 'Native clients only (X-CAN-Client: native).',
  })
  token?: string;
}
export class MeDto {
  @ApiProperty() handle!: string;
  @ApiProperty() role!: string;
}
export class HandleDto {
  @ApiProperty() handle!: string;
}
