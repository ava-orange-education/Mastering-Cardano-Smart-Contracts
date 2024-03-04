import { promises as fs } from 'fs';
import Head from 'next/head';
import type { NextPage } from 'next';
import { useState, useEffect } from 'react';
import path from 'path';

import LoadingSpinner from '../components/LoadingSpinner';
import Mint from '../components/Mint';
import Burn from '../components/Burn';
import { getTicketMetadata } from '../common/network';
import { generateMetadata } from '../common/metadata';
import WalletConnector from '../components/WalletConnector';
import WalletInfo from '../components/WalletInfo';
import { WalletInfoDetails } from '../common/types';

import { 
  applyParamsToScript,
  Constr,
  Data,
  fromText,
  Kupmios,
  Lucid,
  SpendingValidator,
  toText } from "lucid-cardano"; 

// Define the Cardano Network
const network = "Preprod";
const KUPO_API = process.env.NEXT_PUBLIC_KUPO_API as string;
const OGMIOS_API = process.env.NEXT_PUBLIC_OGMIOS_API as string;

if (!KUPO_API && !OGMIOS_API) {
  throw console.error("NEXT_PUBLIC_KUPO_API or NEXT_PUBLIC_OGMIOS_API not set");
}

// Create lucid object and connect it to the kupo + ogmios provider
const lucid = await Lucid.new(
  new Kupmios(
    KUPO_API, 
    OGMIOS_API),
  network,
);


export async function getServerSideProps() {

  try {

    //Find the absolute path of the contracts directory
    const contractDirectory = path.join(process.cwd(), 'contracts');
    
    // Validator script
    const blueprintFile = await fs.readFile(contractDirectory + '/plutus.json', 'utf8');
    const blueprintString = blueprintFile.toString(); 
    return { props: { blueprint: blueprintString } }
  
  } catch (err) {
    console.error('getServerSideProps error: ', err);
  } 
  // No valid blueprint found
  return { props: {} };
}

const Home: NextPage = (props: any) => {

  const [isLoading, setIsLoading] = useState(false);
  const [tx, setTx] = useState({ txId : '' });
  const [walletAPI, setWalletAPI] = useState<undefined | any>(undefined);
  const [walletInfo, setWalletInfo] = useState({ 
      balance : [],
      addr : ''
    });

  useEffect(() => {

    const getWalletInfo = async (): Promise<WalletInfoDetails>  => {

      const utxos = await lucid.wallet.getUtxos();
      let balance = [] as any;
      let index = 0;
      let lovelace = 0n;
      
      utxos.forEach((utxo) =>
        Object.keys(utxo.assets).forEach(key => {
            if (key.length < 57) {
              lovelace += utxo.assets[key];
            } else {
              balance.push({  mph: key.slice(0,56),
                              tn: toText(key.slice(56)),
                              qty: utxo.assets[key],
                              index: index}),
              index += 1
            }
          })
        )
        balance.unshift({ mph: '',
                          tn: 'lovelace',
                          qty: lovelace,
                          index: 0});
        
        const address = await lucid.wallet.address();
        const walletInfoDetails = new WalletInfoDetails(
            address,
            balance
        );
        return walletInfoDetails;
    }

    const updateWalletInfo = async () => {

        if (walletAPI) {
            lucid.selectWallet(walletAPI);
            const wallet_info = await getWalletInfo()
            setWalletInfo({
              balance : wallet_info.balance as [],
              addr: wallet_info.addr
            });
        } else {
          // Zero out wallet info if no walletAPI is present
          setWalletInfo({
            balance : [],
            addr : ''
          })
        }
    }
    updateWalletInfo();
  }, [walletAPI]);

  // Read in the minting script and apply the contract parameters
  async function readValidator( tokenName: string,
                                qty: bigint,
                                outRef: Data): Promise<SpendingValidator> {
    const validator = JSON.parse(props.blueprint).validators[0];
    
    return {
      type: "PlutusV2",
      script: applyParamsToScript(validator.compiledCode, [
                                  fromText(tokenName),
                                  BigInt(qty),
                                  outRef],)
    };
  }

  
    
  const mint = async (params: any) => {
    
    if (params[0].length < 5 ){
      throw console.error("Invalid number of parameters provided");
    }
    const address = params[0] as string;
    const name = params[1] as string;
    const description = params[2] as string;
    const image = params[3] as string;
    const qty = params[4] as number;

    if (!walletAPI) {
      throw console.error("walletAPI is not set");
    }
    setIsLoading(true);
    try {
      lucid.selectWallet(walletAPI);

      // Select wallet UTXOs and use the first one
      const utxos = await lucid?.wallet.getUtxos()!;
      const utxo = utxos[0];

      // Create the UTXO that must be spent as part of this tx
      const outRef = new Constr(0, [
        new Constr(0, [utxo.txHash]),
        BigInt(utxo.outputIndex),
      ]);

      // Read in the minting validator with applied parameters
      const validator = await readValidator(name, BigInt(qty), outRef);

      // Construct the Mint redeemer
      const mintRedeemer = Data.to(new Constr(0, []));

      // Dervie the minting policy id & asset name
      const policyId = lucid.utils.validatorToScriptHash(validator);
      const assetName = `${policyId}${fromText(name)}`;

      // Generate the metadata
      const metadata = generateMetadata(policyId,
                                        name,
                                        description,
                                        image,
                                        BigInt(qty),
                                        utxo.txHash,
                                        utxo.outputIndex);

      const tx = await lucid
        .newTx()
        .collectFrom([utxo])
        .attachMintingPolicy(validator)
        .attachMetadata(721, metadata)
        .mintAssets(
          { [assetName]: BigInt(qty) },
          mintRedeemer
        )
        .payToAddress(address, { [assetName]: BigInt(qty) })
        .complete();

      // Sign the unsigned tx to get the witness
      const signedTx = await tx.sign().complete();

      // Submit the signed tx
      const txHash = await signedTx.submit();

      setTx({ txId: txHash });
      setIsLoading(false);

    } catch (err) {
      setIsLoading(false);
      throw console.error("mint tx failed", err);
    }
  }

  const burn = async (params: any) => {
    
    if (params[0].length < 3 ){
      throw console.error("Invalid number of parameters provided");
    }
    const policyId = params[0] as string;
    const tokenName = params[1] as string;
    const qty = params[2] as number;

    if (!walletAPI) {
      throw console.error("walletAPI is not set");
    }
    setIsLoading(true);
    try {
      lucid.selectWallet(walletAPI);

      // Select wallet UTXOs and use the first one
      const utxos = await lucid?.wallet.getUtxos()!;
      const utxo = utxos[0];

      // Get the Ticket metadata needed for the script parameters
      const ticketMetadata = await getTicketMetadata(policyId, tokenName);

      // Create an outRef based on the txId and TxIdx that was
      // used as minting validator parameters
      const outRef = new Constr(0, [
        new Constr(0, [ticketMetadata.utxoId]),
        BigInt(ticketMetadata.utxoIdx),
      ]);
      
      // Read in the minting validator with applied parameters
      const validator = await readValidator(tokenName,
                                            BigInt(ticketMetadata.qty),
                                            outRef);

      // Construct the Burn redeemer
      const mintRedeemer = Data.to(new Constr(1, []));

      // Dervie the asset name
      const assetName = `${policyId}${fromText(tokenName)}`;

      const tx = await lucid
        .newTx()
        .collectFrom([utxo])
        .attachMintingPolicy(validator)
        .mintAssets(
          { [assetName]: BigInt(-1 * qty) },
          mintRedeemer
        )
        .complete();

      // Sign the unsigned tx to get the witness
      const signedTx = await tx.sign().complete();

      // Submit the signed tx
      const txHash = await signedTx.submit();

      setTx({ txId: txHash });
      setIsLoading(false);

    } catch (err) {
      setIsLoading(false);
      throw console.error("burn tx failed", err);
    }
  }

  return (
    <div className="bg-gray-100 min-h-screen">
      <Head>
        <title>Lucid Transaction Builder</title>
        <meta name="description" content="Lucid Transaction Builder" />
        <link rel="icon" href="/favicon.ico" />
      </Head>
  
      <main className="p-4">
        <h3 className="text-3xl font-semibold text-center mb-8">
          Lucid Transaction Builder
        </h3>
  
        <div className="border border-gray-400 p-4 rounded">
          <WalletConnector onWalletAPI={setWalletAPI} />
        </div>
        { walletAPI && (
          <div className="border border-gray-400 p-4 rounded">
            <WalletInfo walletInfo={walletInfo}/> 
          </div> 
        )}
        {tx.txId && (
          <div className="border border-gray-400 p-4 rounded">
            <b className="font-bold">Transaction Success!!!</b>
            <p>
              TxId: &nbsp;&nbsp;
              <a
                href={"https://"+network+".cexplorer.io/tx/" + tx.txId}
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-500 underline text-xs"
              >
                {tx.txId}
              </a>
            </p>
            <p className="mt-2">Please wait until the transaction is confirmed on the blockchain and reload this page before doing another transaction</p>
          </div>
        )}
        { walletAPI && !tx.txId && !isLoading && (
          <div className="border border-gray-400 p-4 rounded">
            <Mint onMint={mint}/> 
          </div> 
        )}

        { walletAPI && !tx.txId && !isLoading && (
          <div className="border border-gray-400 p-4 rounded">
            <Burn onBurn={burn}/> 
          </div> 
        )}
        { isLoading && (
          <div className="border border-gray-400 p-4 rounded">
            <LoadingSpinner /> 
          </div> 
        )}
        
      </main>
      <footer>
        {/* Footer content */}
      </footer>
    </div>
  );
}

export default Home
