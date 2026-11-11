import {copyFile,rename,rm,constants} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
/** Never overwrite an inode that macOS may still have mapped as signed executable code. */
export async function atomicCopy(source,destination){const temporary=destination+'.new-'+randomUUID();try{await copyFile(source,temporary,constants.COPYFILE_EXCL);await rename(temporary,destination);}finally{await rm(temporary,{force:true});}}
