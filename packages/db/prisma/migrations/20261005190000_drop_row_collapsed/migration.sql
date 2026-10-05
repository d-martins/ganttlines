-- Collapsing rows is a per-browser view now; the stored flag was never used.
ALTER TABLE "Row" DROP COLUMN "collapsed";
