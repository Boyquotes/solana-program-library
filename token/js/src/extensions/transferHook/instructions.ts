import { struct, u8 } from '@solana/buffer-layout';
import type { AccountMeta, Commitment, Connection, PublicKey, Signer } from '@solana/web3.js';
import { TransactionInstruction } from '@solana/web3.js';
import { programSupportsExtensions, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '../../constants.js';
import { TokenUnsupportedInstructionError } from '../../errors.js';
import { addSigners } from '../../instructions/internal.js';
import { TokenInstruction } from '../../instructions/types.js';
import { publicKey } from '@solana/buffer-layout-utils';
import { createTransferCheckedInstruction } from '../../instructions/transferChecked.js';
import { createTransferCheckedWithFeeInstruction } from '../transferFee/instructions.js';
import { getMint } from '../../state/mint.js';
import {
    getExtraAccountMetaAddress,
    getExtraAccountMetaList,
    getTransferHook,
    resolveExtraAccountMeta,
} from './state.js';

export enum TransferHookInstruction {
    Initialize = 0,
    Update = 1,
}

/** Deserialized instruction for the initiation of an transfer hook */
export interface InitializeTransferHookInstructionData {
    instruction: TokenInstruction.TransferHookExtension;
    transferHookInstruction: TransferHookInstruction.Initialize;
    authority: PublicKey;
    transferHookProgramId: PublicKey;
}

/** The struct that represents the instruction data as it is read by the program */
export const initializeTransferHookInstructionData = struct<InitializeTransferHookInstructionData>([
    u8('instruction'),
    u8('transferHookInstruction'),
    publicKey('authority'),
    publicKey('transferHookProgramId'),
]);

/**
 * Construct an InitializeTransferHook instruction
 *
 * @param mint                  Token mint account
 * @param authority             Transfer hook authority account
 * @param transferHookProgramId Transfer hook program account
 * @param programId             SPL Token program account
 *
 * @return Instruction to add to a transaction
 */
export function createInitializeTransferHookInstruction(
    mint: PublicKey,
    authority: PublicKey,
    transferHookProgramId: PublicKey,
    programId: PublicKey
): TransactionInstruction {
    if (!programSupportsExtensions(programId)) {
        throw new TokenUnsupportedInstructionError();
    }
    const keys = [{ pubkey: mint, isSigner: false, isWritable: true }];

    const data = Buffer.alloc(initializeTransferHookInstructionData.span);
    initializeTransferHookInstructionData.encode(
        {
            instruction: TokenInstruction.TransferHookExtension,
            transferHookInstruction: TransferHookInstruction.Initialize,
            authority,
            transferHookProgramId,
        },
        data
    );

    return new TransactionInstruction({ keys, programId, data });
}

/** Deserialized instruction for the initiation of an transfer hook */
export interface UpdateTransferHookInstructionData {
    instruction: TokenInstruction.TransferHookExtension;
    transferHookInstruction: TransferHookInstruction.Update;
    transferHookProgramId: PublicKey;
}

/** The struct that represents the instruction data as it is read by the program */
export const updateTransferHookInstructionData = struct<UpdateTransferHookInstructionData>([
    u8('instruction'),
    u8('transferHookInstruction'),
    publicKey('transferHookProgramId'),
]);

/**
 * Construct an UpdateTransferHook instruction
 *
 * @param mint                  Mint to update
 * @param authority             The mint's transfer hook authority
 * @param transferHookProgramId The new transfer hook program account
 * @param signers               The signer account(s) for a multisig
 * @param tokenProgramId        SPL Token program account
 *
 * @return Instruction to add to a transaction
 */
export function createUpdateTransferHookInstruction(
    mint: PublicKey,
    authority: PublicKey,
    transferHookProgramId: PublicKey,
    multiSigners: (Signer | PublicKey)[] = [],
    programId = TOKEN_2022_PROGRAM_ID
): TransactionInstruction {
    if (!programSupportsExtensions(programId)) {
        throw new TokenUnsupportedInstructionError();
    }

    const keys = addSigners([{ pubkey: mint, isSigner: false, isWritable: true }], authority, multiSigners);
    const data = Buffer.alloc(updateTransferHookInstructionData.span);
    updateTransferHookInstructionData.encode(
        {
            instruction: TokenInstruction.TransferHookExtension,
            transferHookInstruction: TransferHookInstruction.Update,
            transferHookProgramId,
        },
        data
    );

    return new TransactionInstruction({ keys, programId, data });
}

function deEscalateAccountMeta(accountMeta: AccountMeta, accountMetas: AccountMeta[]): AccountMeta {
    const maybeHighestPrivileges = accountMetas
        .filter((x) => x.pubkey === accountMeta.pubkey)
        .reduce<{ isSigner: boolean; isWritable: boolean } | undefined>((acc, x) => {
            if (!acc) return { isSigner: x.isSigner, isWritable: x.isWritable };
            return { isSigner: acc.isSigner || x.isSigner, isWritable: acc.isWritable || x.isWritable };
        }, undefined);
    if (maybeHighestPrivileges) {
        const { isSigner, isWritable } = maybeHighestPrivileges;
        if (!isSigner && isSigner !== accountMeta.isSigner) {
            accountMeta.isSigner = false;
        }
        if (!isWritable && isWritable !== accountMeta.isWritable) {
            accountMeta.isWritable = false;
        }
    }
    return accountMeta;
}

function createExecuteInstruction(
    transferHookProgramId: PublicKey,
    source: PublicKey,
    mint: PublicKey,
    destination: PublicKey,
    authority: PublicKey,
    validateStatePubkey: PublicKey,
    amount: number | bigint
): TransactionInstruction {
    const keys = [source, mint, destination, authority, validateStatePubkey].map((pubkey) => ({
        pubkey,
        isSigner: false,
        isWritable: false,
    }));

    const programId = transferHookProgramId;

    const data = Buffer.alloc(16);
    data.set(Buffer.from([105, 37, 101, 197, 75, 251, 102, 26]), 0); // `Execute` discriminator
    data.writeBigUInt64LE(BigInt(amount), 8);

    return new TransactionInstruction({ keys, programId, data });
}

async function resolveExtraAccountMetasForTransfer(
    connection: Connection,
    source: PublicKey,
    mint: PublicKey,
    destination: PublicKey,
    authority: PublicKey,
    amount: bigint,
    commitment?: Commitment,
    tokenProgramId = TOKEN_PROGRAM_ID
) {
    const mintInfo = await getMint(connection, mint, commitment, tokenProgramId);
    const transferHook = getTransferHook(mintInfo);
    if (transferHook == null) {
        return [];
    }

    const validateStatePubkey = getExtraAccountMetaAddress(mint, transferHook.programId);
    const validateStateAccount = await connection.getAccountInfo(validateStatePubkey, commitment);
    if (validateStateAccount == null) {
        return [];
    }

    // Create an `Execute` instruction, then resolve the extra account metas
    // as configured in the validation account data.
    const executeIx = createExecuteInstruction(
        transferHook.programId,
        source,
        mint,
        destination,
        authority,
        validateStatePubkey,
        amount
    );

    for (const extraAccountMeta of getExtraAccountMetaList(validateStateAccount)) {
        const accountMetaUnchecked = await resolveExtraAccountMeta(
            connection,
            extraAccountMeta,
            executeIx.keys,
            executeIx.data,
            executeIx.programId
        );
        const accountMeta = deEscalateAccountMeta(accountMetaUnchecked, executeIx.keys);
        executeIx.keys.push(accountMeta);
    }
    executeIx.keys.push({ pubkey: transferHook.programId, isSigner: false, isWritable: false });
    executeIx.keys.push({ pubkey: validateStatePubkey, isSigner: false, isWritable: false });

    return executeIx.keys.slice(5);
}

/**
 * Construct an transferChecked instruction with extra accounts for transfer hook
 *
 * @param connection            Connection to use
 * @param source                Source account
 * @param mint                  Mint to update
 * @param destination           Destination account
 * @param authority             The mint's transfer hook authority
 * @param amount                The amount of tokens to transfer
 * @param decimals              Number of decimals in transfer amount
 * @param multiSigners          The signer account(s) for a multisig
 * @param commitment            Commitment to use
 * @param programId             SPL Token program account
 *
 * @return Instruction to add to a transaction
 */
export async function createTransferCheckedWithTransferHookInstruction(
    connection: Connection,
    source: PublicKey,
    mint: PublicKey,
    destination: PublicKey,
    authority: PublicKey,
    amount: bigint,
    decimals: number,
    multiSigners: (Signer | PublicKey)[] = [],
    commitment?: Commitment,
    programId = TOKEN_PROGRAM_ID
) {
    const transferCheckedIx = createTransferCheckedInstruction(
        source,
        mint,
        destination,
        authority,
        amount,
        decimals,
        multiSigners,
        programId
    );

    transferCheckedIx.keys.push(
        ...(await resolveExtraAccountMetasForTransfer(
            connection,
            source,
            mint,
            destination,
            authority,
            amount,
            commitment,
            programId
        ))
    );

    return transferCheckedIx;
}

/**
 * Construct an transferChecked instruction with extra accounts for transfer hook
 *
 * @param connection            Connection to use
 * @param source                Source account
 * @param mint                  Mint to update
 * @param destination           Destination account
 * @param authority             The mint's transfer hook authority
 * @param amount                The amount of tokens to transfer
 * @param decimals              Number of decimals in transfer amount
 * @param fee                   The calculated fee for the transfer fee extension
 * @param multiSigners          The signer account(s) for a multisig
 * @param commitment            Commitment to use
 * @param programId             SPL Token program account
 *
 * @return Instruction to add to a transaction
 */
export async function createTransferCheckedWithFeeAndTransferHookInstruction(
    connection: Connection,
    source: PublicKey,
    mint: PublicKey,
    destination: PublicKey,
    authority: PublicKey,
    amount: bigint,
    decimals: number,
    fee: bigint,
    multiSigners: (Signer | PublicKey)[] = [],
    commitment?: Commitment,
    programId = TOKEN_PROGRAM_ID
) {
    const transferCheckedWithFeeIx = createTransferCheckedWithFeeInstruction(
        source,
        mint,
        destination,
        authority,
        amount,
        decimals,
        fee,
        multiSigners,
        programId
    );

    transferCheckedWithFeeIx.keys.push(
        ...(await resolveExtraAccountMetasForTransfer(
            connection,
            source,
            mint,
            destination,
            authority,
            amount,
            commitment,
            programId
        ))
    );

    return transferCheckedWithFeeIx;
}
