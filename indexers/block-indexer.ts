import dotenv from "dotenv";
import { PrismaClient } from "@prisma/client";
import { ethers } from "ethers";
import { JsonRpcProvider } from "@ethersproject/providers";

dotenv.config();

const rpcUrl = process.env.RPC_URL!;
const maxNumberOfBlockToIndex = parseInt(
  process.env.MAX_NUMBER_OF_BLOCK_TO_INDEX ?? "50"
);
const indexFromBlockNumber = parseInt(
  process.env.INDEX_FROM_BLOCK_NUMBER ?? "0"
);

async function main(db: PrismaClient, provider: JsonRpcProvider) {
  while (true) {
    const latestStoredBlock = await getLatestStoredBlock(db);

    if (latestStoredBlock) {
      // get block hash of stored block from network
      const blockInfo = await provider.getBlock(latestStoredBlock.blockNumber);

      // compare block hash to check for reorg
      const isReorg =
        latestStoredBlock.blockHash.toLowerCase() !==
        blockInfo.hash.toLowerCase();

      // if reorg
      if (isReorg) {
        // delete single block at a time
        await handleReorg(db, latestStoredBlock.blockNumber);
        continue;
      }
    }

    // get latest block from rpc
    const latestRpcBlockNumber = await provider.getBlockNumber();
    if (
      latestStoredBlock &&
      latestStoredBlock.blockNumber > latestRpcBlockNumber
    ) {
      await handleReorg(db, latestRpcBlockNumber);
      continue;
    }

    // index until latest block or until max blockNumber to index,
    // whichever is smaller
    const numOfBlockToIndex = Math.min(
      maxNumberOfBlockToIndex,
      latestRpcBlockNumber -
        (latestStoredBlock ? latestStoredBlock?.blockNumber : 0)
    );

    for (let i = 0; i <= numOfBlockToIndex; i++) {
      // index block and insert to db
      const blockNumber =
        (latestStoredBlock
          ? latestStoredBlock.blockNumber + 1
          : indexFromBlockNumber) + i;
      console.log(`Indexing block ${blockNumber}`);
      const blockInfo = await provider.getBlock(blockNumber);
      await insertLatestBlockNumber(db, blockInfo.number, blockInfo.hash);
    }
  }
}

(async () => {
  console.log("Start indexing block-indexer");
  const prisma = new PrismaClient();
  const provider = new ethers.providers.JsonRpcProvider(rpcUrl);
  // await main(prisma, provider);
})();

export async function getLatestStoredBlock(db: PrismaClient) {
  const latestBlockNumber = await db.latestBlockNumber.findFirst({
    orderBy: {
      blockNumber: "desc",
    },
  });

  return latestBlockNumber;
}

async function insertLatestBlockNumber(
  db: PrismaClient,
  blockNumber: number,
  blockHash: string
) {
  await db.latestBlockNumber.create({
    data: {
      blockNumber: blockNumber,
      blockHash: blockHash,
    },
  });
}

async function handleReorg(db: PrismaClient, reorgFromBlockNumber: number) {
  await db.latestBlockNumber.deleteMany({
    where: {
      blockNumber: {
        gte: reorgFromBlockNumber,
      },
    },
  });
}
