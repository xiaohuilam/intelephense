/* Copyright (c) Ben Robert Mewburn
 * Licensed under the ISC Licence.
 */

'use strict';

import * as fs from 'fs';
import * as mkdirp from 'mkdirp';
import * as path from 'path';
import * as util from './util';

export interface Cache {
    init(): Promise<void>;
    read(key: string): Promise<any>;
    write(key: string, data: any): Promise<void>;
    delete(key: string): Promise<void>;
}

export function createCache(path:string) {
    return new FileCache(path);
}

type Bucket = Item[];
type Item = [string, any];

function writeFile(filePath: string, bucket: Bucket) {
    return new Promise<void>((resolve, reject) => {
        fs.writeFile(filePath, JSON.stringify(bucket), (err) => {
            if (err) {
                reject(err.message);
                return;
            }
            resolve();
        });
    });
}

function deleteFile(filePath: string) {
    return new Promise<void>((resolve, reject) => {
        fs.unlink(filePath, (err) => {
            if (err && err.code !== 'ENOENT') {
                reject(err.message);
                return;
            }
            resolve();
        });
    });
}

function readFile(filePath: string): Promise<Bucket> {

    return new Promise<Bucket>((resolve, reject) => {
        fs.readFile(filePath, (err, data) => {
            if (err) {
                if (err.code === 'ENOENT') {
                    resolve(undefined);
                } else {
                    reject(err.message);
                }
                return;
            }
            resolve(JSON.parse(data.toString()));
        });
    });

}

function bucketFind(bucket: Bucket, key: string) {
    return bucket.find((i) => { return i[0] === key });
}

function bucketRemove(bucket: Bucket, key: string) {
    return bucket.filter((b) => { return b[0] !== key });
}

export class FileCache implements Cache {

    constructor(private path: string) { }

    init() {
        let dir = this.path;
        return new Promise<void>((resolve, reject) => {
            mkdirp(dir, (err) => {
                if (err && err.code !== 'EEXIST') {
                    reject(err.message);
                    return;
                }
                resolve();
            });
        });
    }

    read(key: string) {
        let filePath = this._filePath(key);
        return readFile(filePath).then((b) => {
            let item: Item;
            if (b && (item = bucketFind(b, key))) {
                return Promise.resolve<any>(item[1]);
            } else {
                return Promise.resolve<any>(undefined);
            }
        });

    }

    write(key: string, data: any) {

        let filePath = this._filePath(key);
        return readFile(filePath).then((b) => {

            if (b) {
                b = bucketRemove(b, key);
                b.push([key, data]);
            } else {
                b = [[key, data]];
            }

            return writeFile(filePath, b);
        });

    }

    delete(key: string) {

        let filePath = this._filePath(key);
        return readFile(filePath).then((b) => {
            let item: Item;
            if (b && bucketFind(b, key) && b.length > 1) {
                b = bucketRemove(b, key);
                return writeFile(filePath, b);
            } else if (b) {
                return deleteFile(filePath);
            } else {
                return Promise.resolve();
            }
        });

    }

    private _filePath(key: string) {
        return path.join(this.path, Math.abs(util.hash32(key)).toString(16));
    }

}