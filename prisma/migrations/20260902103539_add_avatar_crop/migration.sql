-- AlterTable
ALTER TABLE "MediaFile" ADD COLUMN     "cropSize" INTEGER,
ADD COLUMN     "cropX" INTEGER,
ADD COLUMN     "cropY" INTEGER,
ADD COLUMN     "purpose" TEXT NOT NULL DEFAULT 'attachment';
